import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

console.log("✅ .env загружен!");
console.log("DATABASE_URL =", process.env.DATABASE_URL);