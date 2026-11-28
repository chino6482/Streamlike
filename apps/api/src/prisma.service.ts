import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;
try {
  prisma = new PrismaClient();
} catch {
  console.warn('[AI Studio] Database not connected — using mock');
  const noOp = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async (d: any) => d?.data ?? {},
    update: async (d: any) => d?.data ?? {},
    delete: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  };
  prisma = new Proxy({} as PrismaClient, { get: () => noOp });
}

export { prisma };
