/**
 * The application menu. Keeps the standard edit shortcuts (needed on macOS
 * for copy and paste) and leaves out Reload outside development, since
 * reloading a window would skip the save-before-close step.
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { appConfig } from '../../app.config'

export function setAppMenu(): void {
  const dev = !app.isPackaged
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: appConfig.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(dev
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const)
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
