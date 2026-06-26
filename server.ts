import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { Contestant, RegisterRequest, QueueState, QueueStatus } from "./src/types";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Persistent storage configuration
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "queues.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initial state
let queueState: QueueState = {
  contestants: [],
  currentCalling: null,
  currentCallingIds: [],
  lastReset: new Date().toISOString(),
};

// Load state from file if exists
if (fs.existsSync(DATA_FILE)) {
  try {
    const rawData = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(rawData);
    if (parsed && Array.isArray(parsed.contestants)) {
      parsed.contestants = parsed.contestants.map((c: any) => {
        if (!c.person1) {
          return {
            id: c.id,
            queueNumber: c.queueNumber,
            queueIndex: c.queueIndex,
            status: c.status,
            registeredAt: c.registeredAt,
            calledAt: c.calledAt,
            completedAt: c.completedAt,
            photoRoom: c.photoRoom || "ห้องถ่ายภาพหลัก (Main Studio)",
            person1: {
              nameTh: c.nameTh || "",
              nameEn: c.nameEn || "",
              deptTh: c.deptTh || "",
              deptEn: c.deptEn || "",
              role: c.role || "other"
            },
            person2: c.person2 || null,
            isPair: c.isPair || false
          };
        }
        return c;
      });
    }
    queueState = parsed;
    console.log(`Loaded and normalized ${queueState.contestants.length} contestants from storage.`);
  } catch (error) {
    console.error("Error reading queues.json, starting with fresh state:", error);
  }
}

// Helper to save state
function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(queueState, null, 2), "utf-8");
  } catch (error) {
    console.error("Error saving state to file:", error);
  }
}

// REST API Endpoints

// 1. Get entire queue state
app.get("/api/queues", (req, res) => {
  res.json(queueState);
});

// 2. Register new contestant(s) (supports unified pair tickets)
app.post("/api/register", (req, res) => {
  const body = req.body as RegisterRequest;
  const { person1, person2, photoRoom } = body;

  if (!person1) {
    res.status(400).json({ error: "Please provide at least the first person to register" });
    return;
  }

  const registeredAt = new Date().toISOString();

  // Find the next queue index
  let nextIndex = 1;
  if (queueState.contestants.length > 0) {
    nextIndex = Math.max(...queueState.contestants.map(c => c.queueIndex)) + 1;
  }

  // Generate queue number (e.g., P-01, P-02)
  const formattedNum = String(nextIndex).padStart(2, "0");
  const queueNumber = `P-${formattedNum}`;
  const id = "contestant_" + Math.random().toString(36).substring(2, 11);

  const newContestant: Contestant = {
    id,
    queueNumber,
    queueIndex: nextIndex,
    status: "waiting",
    registeredAt,
    photoRoom: photoRoom || "ห้องถ่ายภาพหลัก (Main Studio)",
    person1: {
      nameTh: person1.nameTh.trim(),
      nameEn: person1.nameEn.trim(),
      deptTh: person1.deptTh.trim(),
      deptEn: person1.deptEn.trim(),
      role: person1.role,
    },
    person2: person2 ? {
      nameTh: person2.nameTh.trim(),
      nameEn: person2.nameEn.trim(),
      deptTh: person2.deptTh.trim(),
      deptEn: person2.deptEn.trim(),
      role: person2.role,
    } : null,
    isPair: !!person2
  };

  queueState.contestants.push(newContestant);
  saveState();
  
  // Return in array for frontend compatibility
  res.status(201).json([newContestant]);
});

// 3. Get ticket details by ID
app.get("/api/queues/ticket/:id", (req, res) => {
  const { id } = req.params;
  const contestant = queueState.contestants.find(c => c.id === id);

  if (!contestant) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  // Calculate position in queue
  const waitingList = queueState.contestants
    .filter(c => c.status === "waiting")
    .sort((a, b) => a.queueIndex - b.queueIndex);
  
  const waitingIndex = waitingList.findIndex(c => c.id === id);
  const queuesAhead = waitingIndex >= 0 ? waitingIndex : 0;

  res.json({
    contestant,
    queuesAhead,
    currentCalling: queueState.currentCalling,
    isYourTurn: queueState.currentCallingIds.includes(id),
  });
});

// 4. Update queue status (Admin only)
app.post("/api/queues/status", (req, res) => {
  const { ids, status, photoRoom } = req.body as { ids: string[]; status: QueueStatus; photoRoom?: string };

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Please provide an array of contestant IDs" });
    return;
  }

  if (!["waiting", "calling", "completed", "skipped"].includes(status)) {
    res.status(400).json({ error: "Invalid status provided" });
    return;
  }

  const updatedContestants: Contestant[] = [];

  queueState.contestants = queueState.contestants.map(c => {
    if (ids.includes(c.id)) {
      const updated: Contestant = {
        ...c,
        status,
        photoRoom: photoRoom || c.photoRoom,
      };

      if (status === "calling") {
        updated.calledAt = new Date().toISOString();
      } else if (status === "completed") {
        updated.completedAt = new Date().toISOString();
      }

      updatedContestants.push(updated);
      return updated;
    }
    return c;
  });

  // Manage active calling list
  if (status === "calling") {
    // If calling, these IDs become the active calling targets
    const targets = queueState.contestants.filter(c => ids.includes(c.id));
    if (targets.length > 0) {
      // Sort to display nice merged calling numbers, e.g. "P-04, P-05"
      const callingNumbers = targets.map(c => c.queueNumber).sort().join(" & ");
      queueState.currentCalling = callingNumbers;
      queueState.currentCallingIds = ids;
    }
  } else {
    // If completing/skipping, remove from active calling list if they were in it
    queueState.currentCallingIds = queueState.currentCallingIds.filter(id => !ids.includes(id));
    if (queueState.currentCallingIds.length === 0) {
      queueState.currentCalling = null;
    } else {
      const activeTargets = queueState.contestants.filter(c => queueState.currentCallingIds.includes(c.id));
      queueState.currentCalling = activeTargets.map(c => c.queueNumber).sort().join(" & ");
    }
  }

  saveState();
  res.json({ success: true, updated: updatedContestants, state: queueState });
});

// 5. Reset all queues (Admin only)
app.post("/api/queues/reset", (req, res) => {
  const { pin } = req.body as { pin: string };
  
  // Just a simple safety check, in production it would be verified
  if (pin !== "1234") {
    res.status(403).json({ error: "Invalid PIN code to reset queues" });
    return;
  }

  queueState = {
    contestants: [],
    currentCalling: null,
    currentCallingIds: [],
    lastReset: new Date().toISOString(),
  };

  saveState();
  res.json({ success: true, message: "Queue system reset successfully", state: queueState });
});

// 6. Audio Broadcast Endpoint (Polled by client to speak queue announcements)
let audioBroadcasts: { id: string; text: string; timestamp: number }[] = [];

app.post("/api/broadcast", (req, res) => {
  const { text } = req.body as { text: string };
  if (!text) {
    res.status(400).json({ error: "Text is required" });
    return;
  }

  const broadcast = {
    id: "broadcast_" + Math.random().toString(36).substring(2, 11),
    text,
    timestamp: Date.now(),
  };

  audioBroadcasts.push(broadcast);
  // Keep last 20 broadcasts
  if (audioBroadcasts.length > 20) {
    audioBroadcasts.shift();
  }

  res.json({ success: true, broadcast });
});

app.get("/api/broadcast", (req, res) => {
  const since = parseInt(req.query.since as string) || 0;
  const newBroadcasts = audioBroadcasts.filter(b => b.timestamp > since);
  res.json(newBroadcasts);
});


// Vite Dev Server Integration vs Production Build Static Assets
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
