const { app, BrowserWindow } = require('electron');
const path = require('path');

require('./server');

function createWindow() {

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false
        }
    });

    win.loadURL('http://localhost:3000');
}

app.whenReady().then(() => {

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

});

app.on('window-all-closed', () => {

    if (process.platform !== 'darwin') {
        app.quit();
    }

});
