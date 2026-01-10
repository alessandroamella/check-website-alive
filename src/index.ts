import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { differenceInHours } from "date-fns";
import dotenv from "dotenv-safe";
import * as cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";

// Load environment variables
dotenv.config();

interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  urlsFile: string;
  cronSchedule: string;
  timeout: number;
  statusFile: string;
}

interface WebsiteStatus {
  url: string;
  isUp: boolean;
  lastCheckDate: string;
  lastReportDate: string | null;
}

class WebsiteMonitor {
  private bot: TelegramBot;
  private config: Config;
  private websiteStatuses: Map<string, WebsiteStatus> = new Map();

  constructor() {
    this.config = {
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
      telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
      urlsFile: path.join(process.cwd(), process.env.URLS_FILE || "./urls.txt"),
      cronSchedule: process.env.CRON_SCHEDULE || "*/5 * * * *", // Every 5 minutes default
      timeout: parseInt(process.env.TIMEOUT || "5000", 10), // 5 seconds default
      statusFile: path.join(process.cwd(), process.env.STATUS_FILE || "./website-status.json")
    };

    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in environment variables"
      );
    }

    this.bot = new TelegramBot(this.config.telegramBotToken);
  }

  private async loadWebsiteStatuses(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.statusFile, "utf-8");
      const statuses: WebsiteStatus[] = JSON.parse(content);
      this.websiteStatuses.clear();
      statuses.forEach(status => {
        this.websiteStatuses.set(status.url, status);
      });
      console.log(`Loaded ${statuses.length} website statuses from ${this.config.statusFile}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        console.log(`Status file ${this.config.statusFile} not found, starting fresh`);
      } else {
        console.error(`Error reading status file: ${error}`);
      }
      this.websiteStatuses.clear();
    }
  }

  public async saveWebsiteStatuses(): Promise<void> {
    try {
      const statuses = Array.from(this.websiteStatuses.values());
      await fs.writeFile(this.config.statusFile, JSON.stringify(statuses, null, 2));
      console.log(`Saved ${statuses.length} website statuses to ${this.config.statusFile}`);
    } catch (error) {
      console.error(`Error saving status file: ${error}`);
    }
  }

  private async loadUrls(): Promise<string[]> {
    try {
      const content = await fs.readFile(this.config.urlsFile, "utf-8");
      return content
        .split("\n")
        .map(url => url.trim())
        .filter(url => url && !url.startsWith("#"));
    } catch (error) {
      console.error(`Error reading URLs file: ${error}`);
      return [];
    }
  }

  private async checkWebsite(url: string): Promise<boolean> {
    try {
      const response = await axios.get(url, {
        timeout: this.config.timeout,
        headers: {
          "User-Agent": "Website-Monitor/1.0"
        }
      });
      return response.status >= 200 && response.status < 400;
    } catch (error) {
      console.error(`Error checking ${url}:`, (error as Error).message);
      return false;
    }
  }

  private async sendTelegramMessage(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.config.telegramChatId, message, {
        parse_mode: "HTML"
      });
      console.log("Telegram notification sent:", message);
    } catch (error) {
      console.error("Error sending Telegram message:", (error as Error).message);
    }
  }

  private async checkAllWebsites(): Promise<void> {
    const urls = await this.loadUrls();
    if (urls.length === 0) {
      console.log("No URLs to check");
      return;
    }

    console.log(`Checking ${urls.length} websites...`);
    const now = new Date().toISOString();

    // check if it's 00:00 - this often results in error
    if (new Date().getHours() === 0 && new Date().getMinutes() === 0) {
      // SKIP
      console.log("Skipping checks at midnight to avoid false positives");
      return;
    }

    let statusChanged = false;

    for (const url of urls) {
      const isUp = await this.checkWebsite(url);
      const existingStatus = this.websiteStatuses.get(url);

      if (!existingStatus) {
        // First check - just store the status
        const newStatus: WebsiteStatus = {
          url,
          isUp,
          lastCheckDate: now,
          lastReportDate: null
        };
        this.websiteStatuses.set(url, newStatus);
        statusChanged = true;
        console.log(`${url}: ${isUp ? "✅ UP" : "❌ DOWN"} (initial check)`);
      } else {
        // Update last check date
        existingStatus.lastCheckDate = now;

        if (existingStatus.isUp && !isUp) {
          // Website went down
          existingStatus.isUp = false;
          existingStatus.lastReportDate = now;
          statusChanged = true;

          const message =
            `🚨 <b>Website Down Alert</b>\n\n` +
            `<b>URL:</b> ${url}\n` +
            `<b>Status:</b> DOWN\n` +
            `<b>Time:</b> ${new Date().toISOString()}`;

          await this.sendTelegramMessage(message);
          console.log(`${url}: ❌ DOWN (notification sent)`);
        } else if (!existingStatus.isUp && isUp) {
          // Website came back up
          existingStatus.isUp = true;
          existingStatus.lastReportDate = now;
          statusChanged = true;

          const message =
            `✅ <b>Website Recovery Alert</b>\n\n` +
            `<b>URL:</b> ${url}\n` +
            `<b>Status:</b> BACK UP\n` +
            `<b>Time:</b> ${new Date().toISOString()}`;

          await this.sendTelegramMessage(message);
          console.log(`${url}: ✅ BACK UP (notification sent)`);
        } else if (!existingStatus.isUp && !isUp) {
          // Still down - check if we should send reminder after 24 hours
          if (existingStatus.lastReportDate) {
            const hoursSinceLastReport = differenceInHours(
              new Date(),
              new Date(existingStatus.lastReportDate)
            );

            if (hoursSinceLastReport >= 24) {
              existingStatus.lastReportDate = now;
              statusChanged = true;

              const message =
                `🚨 <b>Website Still Down Reminder</b>\n\n` +
                `<b>URL:</b> ${url}\n` +
                `<b>Status:</b> STILL DOWN\n` +
                `<b>Down for:</b> ${hoursSinceLastReport} hours\n` +
                `<b>Time:</b> ${new Date().toISOString()}`;

              await this.sendTelegramMessage(message);
              console.log(`${url}: ❌ STILL DOWN (24h reminder sent)`);
            } else {
              console.log(
                `${url}: ❌ DOWN (no reminder yet - ${hoursSinceLastReport}h since last report)`
              );
            }
          }
        } else {
          // No status change (still up)
          console.log(`${url}: ✅ UP (no change)`);
        }
      }

      // Small delay between checks to avoid overwhelming servers
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Save status changes to file
    if (statusChanged) {
      await this.saveWebsiteStatuses();
    }
  }

  public async start(): Promise<void> {
    console.log("Website Monitor starting...");
    console.log(`Cron schedule: ${this.config.cronSchedule}`);
    console.log(`Timeout: ${this.config.timeout}ms`);
    console.log(`URLs file: ${this.config.urlsFile}`);
    console.log(`Status file: ${this.config.statusFile}`);

    // Load existing website statuses
    await this.loadWebsiteStatuses();

    const urls = await this.loadUrls();
    console.log(`Loaded ${urls.length} URLs to monitor`);

    // Send startup notification
    await this.sendTelegramMessage(
      `🚀 <b>Website Monitor Started</b>\n\n` +
        `Monitor is now running with cron schedule: <code>${this.config.cronSchedule}</code> and timeout ${this.config.timeout}ms\n` +
        `URLs file path: <code>${this.config.urlsFile}</code>\n\n` +
        `Status file path: <code>${this.config.statusFile}</code>\n\n` +
        `We will be monitoring these URLs: ${urls
          .map(url => `<a href="${url}">${url}</a>`)
          .join(", ")}\n` +
        `Time: ${new Date().toISOString()}`
    );

    // Initial check
    await this.checkAllWebsites();

    // Set up cron job for regular checks
    cron.schedule(this.config.cronSchedule, async () => {
      await this.checkAllWebsites();
    });

    console.log("Website Monitor is running...");
  }
}

// Global reference for graceful shutdown
let globalMonitor: WebsiteMonitor | null = null;

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Received SIGINT, shutting down gracefully...");
  if (globalMonitor) {
    try {
      await globalMonitor.saveWebsiteStatuses();
    } catch (error) {
      console.error("Error saving status during shutdown:", error);
    }
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  if (globalMonitor) {
    try {
      await globalMonitor.saveWebsiteStatuses();
    } catch (error) {
      console.error("Error saving status during shutdown:", error);
    }
  }
  process.exit(0);
});

// Start the monitor
async function main() {
  try {
    const monitor = new WebsiteMonitor();
    globalMonitor = monitor;
    await monitor.start();
  } catch (error) {
    console.error("Failed to start website monitor:", error);
    process.exit(1);
  }
}

main();
