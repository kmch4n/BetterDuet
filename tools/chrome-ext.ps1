param(
    [Parameter(Mandatory = $true)][ValidateSet("list", "reload", "enable", "disable", "load", "status")][string]$Action,
    [string]$Name,
    [string]$Path,
    [int]$Window = 0
)
# Drives chrome://extensions through UI Automation (Windows, PowerShell 7).
# Claude in Chrome cannot touch chrome:// pages, so agents use this to load, reload and toggle
# unpacked extensions without a human. See docs/DEVELOPMENT.md for when and how to use it.
#
#   pwsh tools/chrome-ext.ps1 -Action status [-Name BetterDuet]
#   pwsh tools/chrome-ext.ps1 -Action reload -Name BetterDuet
#   pwsh tools/chrome-ext.ps1 -Action enable|disable -Name "BetterDuet Probe"
#   pwsh tools/chrome-ext.ps1 -Action load -Path C:\path	o\extension
#
# -Window is the native handle of the Chrome window to drive. When omitted, the first Chrome window
# that has an "拡張機能" tab or a tab in the Claude tab group is used. The extensions tab is opened
# with Ctrl+T if it is missing. The script brings the window to the foreground because
# chrome://extensions ignores UI Automation actions while its renderer is hidden.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$TW = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }

if ($Window -eq 0) {
    $tabCond = Cond $A::ControlTypeProperty $CT::TabItem
    foreach ($w in $A::RootElement.FindAll($T::Children, (Cond $A::ClassNameProperty "Chrome_WidgetWin_1"))) {
        if ($w.Current.Name -notlike "*Google Chrome*") { continue }
        $hit = $w.FindAll($T::Descendants, $tabCond) | Where-Object { $_.Current.Name -like "拡張機能*" -or $_.Current.Name -like "*Claude グループ*" } | Select-Object -First 1
        if ($hit) { $Window = $w.Current.NativeWindowHandle; break }
    }
    if ($Window -eq 0) { throw "no Chrome window with an extensions tab or a Claude tab group" }
}
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fg { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }
"@
# chrome://extensions ignores UIA actions while its renderer is hidden, so bring the window forward first.
[Fg]::ShowWindow([IntPtr]$Window, 9) | Out-Null
[Fg]::SetForegroundWindow([IntPtr]$Window) | Out-Null
Start-Sleep -Milliseconds 500
$win = $A::RootElement.FindFirst($T::Children, (Cond $A::NativeWindowHandleProperty $Window))
if (-not $win) { throw "window $Window not found" }
$tab = $win.FindAll($T::Descendants, (Cond $A::ControlTypeProperty $CT::TabItem)) | Where-Object { $_.Current.Name -like "拡張機能*" } | Select-Object -First 1
if (-not $tab) {
    # No extensions tab yet: open one with Ctrl+T and the omnibox (chrome:// pages cannot be opened by Claude in Chrome).
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Kb { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); }
"@
    [Kb]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [Kb]::keybd_event(0x54, 0, 0, [UIntPtr]::Zero)
    [Kb]::keybd_event(0x54, 0, 2, [UIntPtr]::Zero); [Kb]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 800
    [System.Windows.Forms.SendKeys]::SendWait("chrome://extensions/{ENTER}")
    Start-Sleep -Seconds 2
    $tab = $win.FindAll($T::Descendants, (Cond $A::ControlTypeProperty $CT::TabItem)) | Where-Object { $_.Current.Name -like "拡張機能*" } | Select-Object -First 1
    if (-not $tab) { throw "extensions tab not found" }
}
$tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
Start-Sleep -Milliseconds 1200

function Get-CardEls($extName) {
    # chrome://extensions exposes every card's controls as flat siblings under one group,
    # so a card is the run of siblings from its "name" element up to the next "name" element.
    $nameEl = $win.FindAll($T::Descendants, (Cond $A::AutomationIdProperty "name")) | Where-Object { $_.Current.Name -eq $extName } | Select-Object -First 1
    if (-not $nameEl) { return $null }
    $parent = $TW.GetParent($nameEl)
    $els = @()
    $started = $false
    foreach ($c in $parent.FindAll($T::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($c.Current.AutomationId -eq "name") {
            if ($started) { break }
            if ($c.Current.Name -eq $extName) { $started = $true }
            continue
        }
        if ($started) { $els += $c }
    }
    return $els
}

function Find-InCard($els, $autoId) {
    foreach ($e in $els) {
        if ($e.Current.AutomationId -eq $autoId) { return $e }
        $hit = $e.FindFirst($T::Descendants, (Cond $A::AutomationIdProperty $autoId))
        if ($hit) { return $hit }
    }
    return $null
}

function Invoke-El($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }

switch ($Action) {
    "list" {
        $win.FindAll($T::Descendants, (Cond $A::AutomationIdProperty "name")) | ForEach-Object { "ext: " + $_.Current.Name }
    }
    "status" {
        foreach ($n in $win.FindAll($T::Descendants, (Cond $A::AutomationIdProperty "name"))) {
            $nm = $n.Current.Name
            if ($Name -and $nm -notlike "$Name*") { continue }
            $card = Get-CardEls $nm
            if (-not $card) { "$nm | card?"; continue }
            $tg = Find-InCard $card "enableToggle"
            $state = ($tg.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState
            $err = Find-InCard $card "errors-button"
            "$nm | toggle=$state | name=" + $tg.Current.Name + " | errors=" + [bool]$err
        }
    }
    "reload" {
        $card = Get-CardEls $Name; if (-not $card) { throw "card $Name not found" }
        $btn = Find-InCard $card "dev-reload-button"
        if (-not $btn) { throw "reload button not found for $Name" }
        Invoke-El $btn; "reloaded $Name"
    }
    { $_ -in "enable", "disable" } {
        $card = Get-CardEls $Name; if (-not $card) { throw "card $Name not found" }
        $btn = Find-InCard $card "enableToggle"
        $isOn = ($btn.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState -eq "On"
        if (($Action -eq "enable") -ne $isOn) { $btn.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); "$Action $Name" } else { "$Name already $Action" }
    }
    "load" {
        Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
}
"@
        $btn = $win.FindFirst($T::Descendants, (Cond $A::AutomationIdProperty "loadUnpacked"))
        Invoke-El $btn
        $dlg = $null
        for ($i = 0; $i -lt 20 -and -not $dlg; $i++) {
            Start-Sleep -Milliseconds 500
            $dlg = $A::RootElement.FindFirst($T::Descendants, (New-Object System.Windows.Automation.AndCondition((Cond $A::ControlTypeProperty $CT::Window), (Cond $A::ClassNameProperty "#32770"))))
        }
        if (-not $dlg) { throw "folder dialog not found" }
        $raw = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $script:found = @{}
        function Walk($el) { $c = $raw.GetFirstChild($el); while ($c) { $id = $c.Current.AutomationId; if ($id -eq "1152" -and $c.Current.ClassName -eq "Edit" -and -not $script:found["1152"]) { $script:found["1152"] = $c }; if ($id -eq "1" -and $c.Current.ClassName -eq "Button" -and -not $script:found["1"]) { $script:found["1"] = $c }; Walk $c; $c = $raw.GetNextSibling($c) } }
        Walk $dlg
        [W32]::SendMessage([IntPtr]$script:found["1152"].Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $Path) | Out-Null
        Start-Sleep -Milliseconds 300
        [W32]::SendMessage([IntPtr]$script:found["1"].Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Start-Sleep -Seconds 2
        "load requested: $Path"
    }
}
