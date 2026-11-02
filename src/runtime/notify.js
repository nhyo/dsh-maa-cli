import { spawn } from 'node:child_process'

// Desktop notifications for things that happen while nobody is looking at the
// run panel. The panel never polls (every /maa status read lands in the
// transcript), so the plugin process announces run endings and copilot job
// switches itself. Notifications are best effort: failing to show one never
// affects the run.

// Windows only shows toasts for a registered AppUserModelID; PowerShell's own
// is present on every Windows 10/11 install.
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

export function notificationsEnabled(env = process.env) {
  if (env.DSH_MAA_NOTIFY === '0') return false
  // node --test exports NODE_TEST_CONTEXT to every test process and the hosts
  // they spawn; the suite must not flood the desktop with toasts.
  if (env.DSH_MAA_NOTIFY !== '1' && env.NODE_TEST_CONTEXT) return false
  return true
}

export function toastScript(title, body) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${psLiteral(xml)})`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(POWERSHELL_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
  ].join('\n')
}

export function desktopNotify(title, body, options = {}) {
  const env = options.env ?? process.env
  if (!notificationsEnabled(env)) return false
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawn ?? spawn
  try {
    let child
    if (platform === 'win32') {
      // -EncodedCommand sidesteps every quoting rule between Node and PowerShell.
      const encoded = Buffer.from(toastScript(String(title), String(body)), 'utf16le').toString('base64')
      child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore', detached: true })
    } else if (platform === 'darwin') {
      child = spawnImpl('osascript', ['-e', `display notification ${appleLiteral(body)} with title ${appleLiteral(title)}`], { stdio: 'ignore', detached: true })
    } else {
      child = spawnImpl('notify-send', [String(title), String(body)], { stdio: 'ignore', detached: true })
    }
    child.on?.('error', () => {})
    child.unref?.()
    return true
  } catch {
    return false
  }
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char])
}

function psLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

function appleLiteral(value) {
  return `"${String(value).replace(/["\\]/gu, char => `\\${char}`)}"`
}
