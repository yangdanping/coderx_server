import type { Server, Socket } from 'socket.io';
import type { PresenceAuth } from '../auth/socketAuth.factory.js';
import type { OnlineUser } from '../presence/presence.types.js';
import type { NotificationPayload } from '../notification/notificationEvent.js';

type NoEvents = Record<never, never>;
type ServerEvents = {
  online: (status: { userList: OnlineUser[] }) => void;
  'notification:new': (notification: NotificationPayload) => void;
};
type SocketData = { presenceAuth?: PresenceAuth };

export type SocketServer = Server<NoEvents, ServerEvents, NoEvents, SocketData>;
export type PresenceSocket = Socket<NoEvents, ServerEvents, NoEvents, SocketData>;
export type Close = () => void | Promise<void>;
export interface Closable { close: Close }
