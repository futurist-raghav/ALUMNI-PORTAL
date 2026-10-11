import prisma from '../config/prisma';
import { randomUUID } from 'node:crypto';

type NotificationInput = {
  userId: string;
  title: string;
  message: string;
  type?: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
};

export const createNotification = async ({
  userId,
  title,
  message,
  type = 'info',
  actionUrl,
  metadata
}: NotificationInput) => {
  try {
    await prisma.notification.create({
      data: {
        id: randomUUID(),
        userId,
        title,
        message,
        type,
        actionUrl: actionUrl ?? null,
        metadata: (metadata as any) ?? undefined
      }
    });

    return true;
  } catch (error) {
    console.error('Failed to create notification:', {
      userId,
      title,
      type,
      error
    });
    return null;
  }
};
