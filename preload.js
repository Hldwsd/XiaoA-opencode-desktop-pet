'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getProgress: () => ipcRenderer.invoke('get-progress'),
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  getCharacters: () => ipcRenderer.invoke('get-characters'),
  getCurrentCharacter: () => ipcRenderer.invoke('get-current-character'),
  setCharacter: (name) => ipcRenderer.send('set-character', name),
  deleteCharacter: (name) => ipcRenderer.invoke('delete-character', name),
  pickImage: (title) => ipcRenderer.invoke('pick-image', title),
  createCharacter: (data) => ipcRenderer.invoke('create-character', data),
  closeCreate: () => ipcRenderer.send('create-close'),
  selectSession: (id) => ipcRenderer.send('select-session', id),
  deleteSession: (id) => ipcRenderer.invoke('delete-session', id),
  togglePopup: () => ipcRenderer.send('toggle-popup'),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  quit: () => ipcRenderer.send('quit'),
  onProgress: (cb) => ipcRenderer.on('progress-updated', (_e, data) => cb(data)),
  onSessions: (cb) => ipcRenderer.on('sessions-updated', (_e, data) => cb(data)),
  onPetChanged: (cb) => ipcRenderer.on('pet-changed', (_e, data) => cb(data)),
  onMenuShow: (cb) => ipcRenderer.on('menu-show', (_e, data) => cb(data)),
  menuClick: (id) => ipcRenderer.send('menu-click', id),
  menuDel: (id) => ipcRenderer.send('menu-del', id),
  menuHide: () => ipcRenderer.send('menu-hide'),
  menuFit: (size) => ipcRenderer.send('menu-fit', size),
  menuReady: () => ipcRenderer.send('menu-ready'),
  grantPermission: (allow) => ipcRenderer.invoke('grant-permission', allow),
  hidePermission: () => ipcRenderer.send('permission-hide'),
  onPermission: (cb) => ipcRenderer.on('permission-show', (_e, data) => cb(data)),
  onPermissionShake: (cb) => ipcRenderer.on('permission-shake', () => cb()),
  onPopupOpacityChanged: (cb) => ipcRenderer.on('popup-opacity-changed', (_e, data) => cb(data)),
});