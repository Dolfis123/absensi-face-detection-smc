import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { requireAuth } from './middleware/auth';
import { errorHandler } from './middleware/error';
import adminRoutes from './routes/admin';
import attendanceRoutes from './routes/attendance';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import monitorRoutes from './routes/monitor';
import planningRoutes from './routes/planning';

export const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.corsOrigin.split(',').map((o) => o.trim()) }));
// Pendaftaran wajah mengirim sampai 5 foto base64 sekaligus
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes); // publik: tombol "Absen Sekarang"
app.use('/api/me', requireAuth, meRoutes);
// planningRoutes (roster & pengaturan shift) juga untuk Koordinator; sisanya khusus Super Admin
app.use('/api/admin', requireAuth, planningRoutes, adminRoutes);
app.use('/api', requireAuth, monitorRoutes);

app.use('/api', (_req, res) => res.status(404).json({ message: 'Endpoint tidak ditemukan' }));
app.use(errorHandler);
