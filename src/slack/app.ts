import { App } from '@slack/bolt';
import type { WebClientOptions } from '@slack/web-api';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export function createSlackApp(): App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    // Raise the Web API HTTP timeout from the default 3 s to 30 s so replies
    // aren't lost to transient ETIMEDOUTs (same fix as receipt-agent).
    clientOptions: { timeout: 30000 } as Pick<WebClientOptions, 'slackApiUrl'>,
  });

  logger.info('Slack Bolt app created (Socket Mode)');
  return app;
}
