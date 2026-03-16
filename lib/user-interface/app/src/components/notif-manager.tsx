import * as React from "react";
import { createContext, useState, useContext, useCallback, useRef } from "react";
import { v4 as uuidv4 } from 'uuid';

const AUTO_HIDE_MS: Record<string, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

export const NotificationContext = createContext({
  notifications: [] as any[],
  addNotification: (_type: string, _content: string) => "" as string,
  removeNotification: (_id: string) => {},
});

export const NotificationProvider = ({ children }: { children: React.ReactNode }) => {
  const [notifications, setNotifications] = useState<any[]>([]);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const removeNotification = useCallback((id: string) => {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const addNotification = useCallback((type: string, content: string): string => {
    const id = uuidv4();

    setNotifications(prev => [...prev, {
      id,
      type,
      content,
      date: Date.now(),
      dismissible: true,
      dismissLabel: "Hide notification",
      onDismiss: () => removeNotification(id),
    }]);

    const delay = AUTO_HIDE_MS[type] ?? AUTO_HIDE_MS.info;
    timersRef.current[id] = setTimeout(() => removeNotification(id), delay);

    return id;
  }, [removeNotification]);

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, removeNotification }}>
      {children}
    </NotificationContext.Provider>
  );
};

export const useNotifications = () => useContext(NotificationContext);
