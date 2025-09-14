import { Server } from "http";
import mongoose from "mongoose";
import app from "./app";
import config from "./app/config";

import httpStatus from "http-status";
import AppError from "./app/errors/AppError";
import { WebSocketServer, WebSocket } from "ws";
import channels from "./app/modules/channel/channel.model";
import messages from "./app/modules/message/message.model";

let server: Server | null = null;
let wss: WebSocketServer | null = null;

type channelName = string;
const channelClients = new Map<channelName, Set<WebSocket>>();

function safeSend(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToChannel(
  channelName: channelName,
  data: unknown,
  excludeSocket: WebSocket | null = null
) {
  const clients = channelClients.get(channelName);
  if (!clients) return;
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (excludeSocket && client === excludeSocket) continue;
    safeSend(client, data);
  }
}

// Heartbeat helper to detect dead connections
function installHeartbeat(wss: WebSocketServer) {
  wss.on("connection", (ws: WebSocket & { isAlive?: boolean }) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket & { isAlive?: boolean }) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(interval));
}

async function main() {
  try {
    await mongoose.connect(config.database_url as string);
    console.log("database connected successfully");

    server = app.listen(config.port, () => {
      console.log(` app listening http://${config.host}:${config.port}`);
    });

    wss = new WebSocketServer({ server });
    installHeartbeat(wss);

    wss.on("connection", (ws: WebSocket & { isAlive?: boolean }, req) => {
      console.log("New WebSocket connection");
      let currentChannel: string | null = null;

      ws.on("message", async (raw: Buffer) => {
        try {
          const msgStr = raw.toString().trim();
          // console.log("Received WS message:", msgStr);

          const parsed = JSON.parse(msgStr);

          switch (parsed?.type) {
            case "subscribe": {
              const channelName: string = parsed.channelName;
              if (!channelName || typeof channelName !== "string") {
                safeSend(ws, { type: "error", message: "Invalid channelName" });
                return;
              }

              if (!channelClients.has(channelName)) {
                channelClients.set(channelName, new Set());
              }
              channelClients.get(channelName)!.add(ws);
              currentChannel = channelName;

              safeSend(ws, { type: "subscribed", channelName });
              break;
            }

            case "message": {
              const channelName: string = parsed.channelName;
              const messageText: string = parsed.message;
              const senderId: string = parsed.senderId || "";

              if (!channelName || typeof channelName !== "string") {
                safeSend(ws, { type: "error", message: "Invalid channelName" });
                return;
              }

              if (!senderId) {
                safeSend(ws, {
                  type: "error",
                  message: "senderId is required",
                });
                return;
              }

              // find or create channel
              let channel = await channels.findOne({ channelName });

              if (!channel) {
                channel = await channels.create({
                  channelName,
                  senderId,
                  receiverId: parsed.receiverId || "",
                });
              }

              // save message

              const newMessage = await messages.create({
                message: messageText,
                senderId,
                channelName: channel.channelName,
                files: parsed.files || [],
              });

              // populate sender like Prisma include
              const populatedMessage = await messages
                .findById(newMessage._id)
                .populate({
                  path: "senderId",
                  select: "id fullName profileImage",
                });

              if (!populatedMessage) {
                throw new AppError(
                  httpStatus.INTERNAL_SERVER_ERROR,
                  "some issues by the populate message",''
                );
              }

              broadcastToChannel(
                channel.channelName,
                {
                  type: "message",
                  channelName: channel.channelName,
                  data: newMessage,
                },
                ws
              );

              break;
            }

            default:
              safeSend(ws, { type: "error", message: "Unknown message type" });
          }
        } catch (err: any) {
          console.error("WS message error:", err?.message || err);
          safeSend(ws, {
            type: "error",
            message: "Malformed JSON",
            raw: raw.toString(),
          });
        }
      });

      ws.on("close", () => {
        if (currentChannel) {
          const set = channelClients.get(currentChannel);
          if (set) {
            set.delete(ws);
            if (set.size === 0) channelClients.delete(currentChannel);
          }
        }
        console.log("❌ Client disconnected");
      });

      ws.on("error", (err) => {
        console.error("WS socket error:", err);
      });
    });

    process.on("unhandledRejection", () => {
      if (server) {
        server.close(() => {
          process.exit(1);
        });
      } else {
        process.exit(1);
      }
    });

    process.on("uncaughtException", () => {
      if (server) {
        server.close(() => {
          process.exit(1);
        });
      } else {
        process.exit(1);
      }
    });

    process.on("SIGTERM", () => {
      console.log("SIGTERM received");
      if (server) {
        server.close(() => {
          console.log("Server closed due to SIGTERM");
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });

    process.on("SIGINT", () => {
      console.log("SIGINT received");
      if (server) {
        server.close(() => {
          console.log("Server closed due to SIGINT");
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  } catch (err: any) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "server unavailable",
      err
    );
  }
}

main().then(() => {
  console.log("-- Mandhirhoth server is running---");
});
