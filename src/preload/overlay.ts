import { contextBridge, ipcRenderer } from 'electron';
import type { Participant } from '../shared/types';

/** The overlay receives state and sends nothing. Narrower than the main bridge. */
contextBridge.exposeInMainWorld('overlay', {
  onParticipants: (cb: (participants: Participant[]) => void) =>
    ipcRenderer.on('overlay:participants', (_e, participants: Participant[]) => cb(participants)),
  onDragMode: (cb: (dragging: boolean) => void) =>
    ipcRenderer.on('overlay:drag', (_e, dragging: boolean) => cb(dragging)),
});
