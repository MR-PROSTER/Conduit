import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createBackendServer } from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load dotenv from ../.env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Re-export all public types and functions from sub-modules
export * from "./supabaseClient.js";
export * from "./permissions.js";
export * from "./supabaseAuth.js";
export * from "./roomManager.js";
export * from "./sessionRegistry.js";
export * from "./yjs-server.js";
export * from "./websocket.js";
export * from "./migration.js";
export * from "./authRoutes.js";
export * from "./roomRoutes.js";
export * from "./draftRepository.js";
export * from "./draftRoutes.js";
export * from "./chatRepository.js";
export * from "./chatRoutes.js";
export * from "./server.js";

// Call createBackendServer() with env vars
const server = createBackendServer({
    host: process.env.HOST || "0.0.0.0",
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 4000,
    websocketPath: process.env.WEBSOCKET_PATH || "/ws",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "",
});

export { server };

// Register SIGINT/SIGTERM shutdown handlers
const handleShutdown = async (signal: string) => {
    console.log(`\n[INFO] Received ${signal}. Starting graceful shutdown...`);
    try {
        await server.stop();
        console.log("[INFO] Graceful shutdown complete.");
        process.exit(0);
    } catch (error) {
        console.error("[ERROR] Error encountered during shutdown:", error);
        process.exit(1);
    }
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

// Call server.start() if not in test mode
if (process.env.NODE_ENV !== "test") {
    server.start().catch((error) => {
        console.error("[FATAL] Failed to start backend server:", error);
        process.exit(1);
    });
}
