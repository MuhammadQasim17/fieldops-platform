import { prisma } from '../prisma';

export async function restoreHistory() {
  const qasim = await prisma.user.findFirst({
    where: { email: 'qasimwanted9@gmail.com' },
  });

  if (!qasim) {
    console.error('Muhammad Qasim not found in User table');
    process.exit(1);
  }

  const result = await prisma.job.updateMany({
    where: { status: 'COMPLETED' },
    data: { technicianId: qasim.id },
  });

  console.log(`Successfully restored ${result.count} completed tasks to Muhammad Qasim (${qasim.id})`);
  return result;
}

if (require.main === module) {
  restoreHistory()
    .catch((err) => {
      console.error('Error restoring history:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

