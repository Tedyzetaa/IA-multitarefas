"use client";
import { useEffect, useRef, useState } from "react";
import { nexusBridge } from "@/lib/nexusBridge";

export function useNexusStream() {
  const socketRef = useRef<WebSocket | null>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  useEffect(() => () => socketRef.current?.close(), []);
  function connect() {
    socketRef.current?.close();
    socketRef.current = nexusBridge.connectChat((event) => setEvents((current) => [...current, event]));
  }
  return { events, connect, socket:socketRef.current };
}
