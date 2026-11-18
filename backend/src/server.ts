import { app } from './app';
import { bootstrap } from './bootstrap';
import { env } from './config/env';
import { startMonitor } from './services/systemMonitor';
import { startTelegramPoller } from './services/telegramBot';
import { startAutoNotify } from './services/autoNotify';

bootstrap()
  .then(() => {
    app.listen(env.port, env.host, () => console.log(`🚗 SMC-FaceAttend API berjalan di http://${env.host}:${env.port}`));
    startMonitor();
    startTelegramPoller();
    startAutoNotify();
  })
  .catch((err) => {
    console.error('Gagal menyiapkan database:', err);
    process.exit(1);
  });
