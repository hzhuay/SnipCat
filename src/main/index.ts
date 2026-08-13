import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { registerIpc, shutdownJobs } from './ipc'
import { registerMediaProtocol, registerMediaSchemePrivileges } from './mediaProtocol'

// 必须在 app ready 之前声明协议权限
registerMediaSchemePrivileges()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 900,
    minHeight: 680,
    show: false,
    title: 'SnipCat',
    backgroundColor: '#1a1a1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // 渲染进程不直接碰 Node，一切能力经 preload 白名单暴露
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 外部链接交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

void app.whenReady().then(() => {
  registerMediaProtocol()
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前清掉所有受管 ffmpeg 子进程（含被后台队列挂起的）。
// killAllManaged 用同步 taskkill，退出前必然落地；taskkill /T /F 对挂起进程同样有效。
app.on('before-quit', () => {
  shutdownJobs()
})
