import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import {
  clearSrsData,
  createChatSession,
  createSrsItem,
  updateSrsItem,
  deleteChatSession,
  deleteSrsItem,
  closeDatabases,
  exportSrsItems,
  getChatSession,
  getDictionaryStatus,
  getSrsDueCount,
  getSrsReviewQueue,
  getSrsStats,
  initializeDatabases,
  listDueSrsItems,
  listChatSessions,
  loadKuromojiDictionaryFile,
  onSrsDataChanged,
  lookupDictionaryEntries,
  saveChatSession,
  submitSrsReview,
} from './database';
import { requireActiveInferenceProvider } from './inference/service';
import {
  getUserPreferences,
  initializeSettingsStore,
  saveUserPreferences,
} from '@/settings-store';
import {
  IPC_CHANNELS,
  type CreateSrsItemInput,
  type DictionaryLookupQuery,
  type InferenceStreamEvent,
  type InferenceStreamEventEnvelope,
  type InferenceStreamStartRequest,
  type ListDueSrsItemsInput,
  type SaveChatSessionInput,
  type SubmitSrsReviewInput,
  type UpdateSrsItemInput,
  type UserPreferencesUpdate,
} from './shared/language-api';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const getDevAppIconPath = () =>
  path.join(app.getAppPath(), 'assets', 'icons', 'app-icon.png');
const SRS_BADGE_REFRESH_INTERVAL_MS = 60_000;

let srsBadgeRefreshInterval: ReturnType<typeof setInterval> | null = null;
let disposeSrsBadgeChangeListener: (() => void) | null = null;

const updateSrsBadgeCount = () => {
  const dueCount = getSrsDueCount();
  app.setBadgeCount(Math.max(0, dueCount));
};

const startSrsBadgeUpdates = () => {
  updateSrsBadgeCount();

  disposeSrsBadgeChangeListener = onSrsDataChanged(() => {
    updateSrsBadgeCount();
  });

  srsBadgeRefreshInterval = setInterval(() => {
    updateSrsBadgeCount();
  }, SRS_BADGE_REFRESH_INTERVAL_MS);
};

const stopSrsBadgeUpdates = () => {
  if (srsBadgeRefreshInterval) {
    clearInterval(srsBadgeRefreshInterval);
    srsBadgeRefreshInterval = null;
  }

  if (disposeSrsBadgeChangeListener) {
    disposeSrsBadgeChangeListener();
    disposeSrsBadgeChangeListener = null;
  }
};

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#09090b',
    title: 'ToraToki',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

const registerIpcHandlers = () => {
  ipcMain.handle(
    IPC_CHANNELS.clearSrsData,
    () => clearSrsData(),
  );

  ipcMain.handle(
    IPC_CHANNELS.getSrsStats,
    () => getSrsStats(),
  );

  ipcMain.handle(
    IPC_CHANNELS.listDueSrsItems,
    (_event, input?: ListDueSrsItemsInput) => listDueSrsItems(input),
  );

  ipcMain.handle(
    IPC_CHANNELS.getSrsReviewQueue,
    () => getSrsReviewQueue(),
  );

  ipcMain.handle(
    IPC_CHANNELS.createSrsItem,
    (_event, input: CreateSrsItemInput) => createSrsItem(input),
  );

  ipcMain.handle(
    IPC_CHANNELS.updateSrsItem,
    (_event, input: UpdateSrsItemInput) => updateSrsItem(input),
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteSrsItem,
    (_event, itemId: string) => deleteSrsItem(itemId),
  );

  ipcMain.handle(
    IPC_CHANNELS.submitSrsReview,
    (_event, input: SubmitSrsReviewInput) => submitSrsReview(input),
  );

  ipcMain.handle(
    IPC_CHANNELS.exportSrsItems,
    () => exportSrsItems(app.getPath('downloads')),
  );

  ipcMain.handle(
    IPC_CHANNELS.listChatSessions,
    () => listChatSessions(),
  );

  ipcMain.handle(
    IPC_CHANNELS.createChatSession,
    () => createChatSession(),
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteChatSession,
    (_event, chatId: string) => deleteChatSession(chatId),
  );

  ipcMain.handle(
    IPC_CHANNELS.getChatSession,
    (_event, chatId: string) => getChatSession(chatId),
  );

  ipcMain.handle(
    IPC_CHANNELS.saveChatSession,
    (_event, input: SaveChatSessionInput) => saveChatSession(input),
  );

  ipcMain.handle(
    IPC_CHANNELS.getUserPreferences,
    () => getUserPreferences(),
  );

  ipcMain.handle(
    IPC_CHANNELS.saveUserPreferences,
    (_event, update: UserPreferencesUpdate) => saveUserPreferences(update),
  );

  ipcMain.handle(
    IPC_CHANNELS.getDictionaryStatus,
    () => getDictionaryStatus(),
  );

  ipcMain.handle(
    IPC_CHANNELS.loadKuromojiDictionaryFile,
    (_event, fileName: string) => loadKuromojiDictionaryFile(fileName),
  );

  ipcMain.handle(
    IPC_CHANNELS.lookupDictionaryEntries,
    (_event, query: DictionaryLookupQuery) => lookupDictionaryEntries(query),
  );

  ipcMain.on(
    IPC_CHANNELS.startInferenceStream,
    (event, input: InferenceStreamStartRequest) => {
      const sendStreamEvent = (streamEvent: InferenceStreamEvent) => {
        const envelope: InferenceStreamEventEnvelope = {
          requestId: input.requestId,
          event: streamEvent,
        };

        event.sender.send(IPC_CHANNELS.inferenceStreamEvent, envelope);
      };

      void (async () => {
        try {
          const provider = requireActiveInferenceProvider();

          for await (const streamEvent of provider.streamChatResponse(input.request)) {
            sendStreamEvent(streamEvent);
          }
        } catch (error) {
          sendStreamEvent({
            type: 'response.error',
            message:
              error instanceof Error
                ? error.message
                : 'Inference stream failed unexpectedly.',
          });
        }
      })();
    },
  );
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  app.setName('ToraToki');
  initializeSettingsStore();
  initializeDatabases({
    userDataPath: app.getPath('userData'),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });

  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(getDevAppIconPath());
  }

  startSrsBadgeUpdates();
  registerIpcHandlers();
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopSrsBadgeUpdates();
  closeDatabases();
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
