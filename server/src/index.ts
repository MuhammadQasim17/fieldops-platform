import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'FieldOps API' });
});

// GET: All assigned jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      orderBy: { createdAt: 'desc' },
      include: { technician: { select: { name: true, phone: true } } },
    });
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// PATCH: Update job status and signature from mobile
app.patch('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  const { status, completionNotes, signatureData } = req.body;

  try {
    const updatedJob = await prisma.job.update({
      where: { id },
      data: {
        status: status || undefined,
        completionNotes: completionNotes || undefined,
        signatureData: signatureData || undefined,
        completedAt: status === 'COMPLETED' ? new Date() : undefined,
      },
    });
    res.json(updatedJob);
  } catch (error) {
    console.error('Error updating job:', error);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});