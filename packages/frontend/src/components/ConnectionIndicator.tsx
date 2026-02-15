import { useProjectWebSocket } from '../contexts/ProjectWebSocketContext';

/**
 * Shows connection status only when offline. Hidden when server is online and
 * websockets are connected.
 */
export function ConnectionIndicator() {
  const { connected } = useProjectWebSocket();

  if (connected) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-sm text-red-600">
      <div className="w-2 h-2 rounded-full bg-red-500" />
      <span>Offline</span>
    </div>
  );
}
