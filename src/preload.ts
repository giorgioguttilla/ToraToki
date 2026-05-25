import { contextBridge, ipcRenderer } from 'electron';
import {
	IPC_CHANNELS,
	type InferenceStreamEventEnvelope,
	type LanguageAppApi,
} from './shared/language-api';

const languageApp: LanguageAppApi = {
	versions: {
		chrome: process.versions.chrome,
		electron: process.versions.electron,
		node: process.versions.node,
	},
	chat: {
		listSessions: () =>
			ipcRenderer.invoke(IPC_CHANNELS.listChatSessions),
		createSession: () =>
			ipcRenderer.invoke(IPC_CHANNELS.createChatSession),
		deleteSession: (chatId) =>
			ipcRenderer.invoke(IPC_CHANNELS.deleteChatSession, chatId),
		getSession: (chatId) =>
			ipcRenderer.invoke(IPC_CHANNELS.getChatSession, chatId),
		saveSession: (input) =>
			ipcRenderer.invoke(IPC_CHANNELS.saveChatSession, input),
	},
	dictionary: {
		getStatus: () =>
			ipcRenderer.invoke(IPC_CHANNELS.getDictionaryStatus),
		lookupEntries: (query) =>
			ipcRenderer.invoke(IPC_CHANNELS.lookupDictionaryEntries, query),
	},
	inference: {
		startChatCompletionStream: (input) => {
			ipcRenderer.send(IPC_CHANNELS.startInferenceStream, input);
		},
		onChatCompletionStreamEvent: (listener) => {
			const handler = (
				_event: Electron.IpcRendererEvent,
				event: InferenceStreamEventEnvelope,
			) => {
				listener(event);
			};

			ipcRenderer.on(IPC_CHANNELS.inferenceStreamEvent, handler);

			return () => {
				ipcRenderer.removeListener(IPC_CHANNELS.inferenceStreamEvent, handler);
			};
		},
	},
	settings: {
		getPreferences: () =>
			ipcRenderer.invoke(IPC_CHANNELS.getUserPreferences),
		savePreferences: (update) =>
			ipcRenderer.invoke(IPC_CHANNELS.saveUserPreferences, update),
	},
	srs: {
		clearData: () =>
			ipcRenderer.invoke(IPC_CHANNELS.clearSrsData),
		getStats: () =>
			ipcRenderer.invoke(IPC_CHANNELS.getSrsStats),
		listDueItems: (input) =>
			ipcRenderer.invoke(IPC_CHANNELS.listDueSrsItems, input),
		getReviewQueue: () =>
			ipcRenderer.invoke(IPC_CHANNELS.getSrsReviewQueue),
		createItem: (input) =>
			ipcRenderer.invoke(IPC_CHANNELS.createSrsItem, input),
			updateItem: (input) =>
				ipcRenderer.invoke(IPC_CHANNELS.updateSrsItem, input),
		deleteItem: (itemId) =>
			ipcRenderer.invoke(IPC_CHANNELS.deleteSrsItem, itemId),
		exportItems: () =>
			ipcRenderer.invoke(IPC_CHANNELS.exportSrsItems),
		submitReview: (input) =>
			ipcRenderer.invoke(IPC_CHANNELS.submitSrsReview, input),
	},
	kuromoji: {
		loadDictionaryFile: (fileName) =>
			ipcRenderer.invoke(IPC_CHANNELS.loadKuromojiDictionaryFile, fileName),
	},
};

contextBridge.exposeInMainWorld('languageApp', languageApp);
