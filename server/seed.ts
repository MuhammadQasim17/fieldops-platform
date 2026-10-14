import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding initial technician and jobs...');

  // Clean old records
  await prisma.job.deleteMany();
  await prisma.user.deleteMany();

  // 1. Create a Technician User
  const technician = await prisma.user.create({
    data: {
      name: 'Muhammad Qasim',
      email: 'tech@fieldops.com',
      password: 'password123',
      role: 'TECHNICIAN',
      phone: '+92 300 1234567',
    },
  });

  // 2. Create Realistic Field Jobs
  await prisma.job.createMany({
    data: [
      {
        title: 'Emergency AC Cooling Failure',
        description: 'Compressor unit is leaking refrigerant and making loud vibration noises.',
        customerName: 'Apex Commercial Plaza',
        customerPhone: '+92 321 9876543',
        customerAddress: 'Suite 402, Main Boulevard, Gulberg III',
        priority: 'EMERGENCY',
        status: 'PENDING',
        technicianId: technician.id,
      },
      {
        title: 'Fiber Optic Line Termination',
        description: 'Splice and terminate 12-core single-mode fiber patch panel in server rack.',
        customerName: 'TechVision Solutions',
        customerPhone: '+92 333 4455667',
        customerAddress: 'Building 14-B, Sector Y, DHA Phase 3',
        priority: 'HIGH',
        status: 'PENDING',
        technicianId: technician.id,
      },
      {
        title: 'Solar Inverter Annual Inspection',
        description: 'Perform voltage drop inspection and clean DC disconnect switchgear.',
        customerName: 'Dr. Tariq Mahmood',
        customerPhone: '+92 300 7788990',
        customerAddress: 'House 88, Canal View Housing Society',
        priority: 'MEDIUM',
        status: 'PENDING',
        technicianId: technician.id,
      },
    ],
  });

  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });