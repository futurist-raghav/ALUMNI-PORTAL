import { Request, Response } from 'express';
import prisma from '../config/prisma';

interface AuthRequest extends Request {
  user?: {
    id: string;
  };
}

export const getNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const pageValue = typeof req.query.page === 'string' ? req.query.page : undefined;
    const limitValue = typeof req.query.limit === 'string' ? req.query.limit : undefined;
    const pageRaw = pageValue ? Number.parseInt(pageValue, 10) : 1;
    const limitRaw = limitValue ? Number.parseInt(limitValue, 10) : 20;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20, 100);
    const skip = (page - 1) * limit;

    const [notifications, unseenCount, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          message: true,
          type: true,
          actionUrl: true,
          metadata: true,
          isSeen: true,
          createdAt: true
        }
      }),
      prisma.notification.count({
        where: {
          userId,
          isSeen: false
        }
      }),
      prisma.notification.count({
        where: {
          userId
        }
      })
    ]);

    res.json({
      success: true,
      data: notifications,
      unseenCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
};

export const markNotificationSeen = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const notificationId = String(req.params.notificationId || '');

    const { count: updatedCount } = await prisma.notification.updateMany({
      where: {
        id: notificationId,
        userId
      },
      data: {
        isSeen: true,
        seenAt: new Date()
      }
    });

    if (updatedCount === 0) {
      res.status(404).json({ success: false, message: 'Notification not found' });
      return;
    }

    res.json({ success: true, message: 'Notification marked as seen' });
  } catch (error) {
    console.error('Error marking notification as seen:', error);
    res.status(500).json({ success: false, message: 'Failed to mark notification as seen' });
  }
};

export const markAllNotificationsSeen = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    await prisma.notification.updateMany({
      where: {
        userId,
        isSeen: false
      },
      data: {
        isSeen: true,
        seenAt: new Date()
      }
    });

    res.json({ success: true, message: 'All notifications marked as seen' });
  } catch (error) {
    console.error('Error marking all notifications as seen:', error);
    res.status(500).json({ success: false, message: 'Failed to mark all notifications as seen' });
  }
};

export const dismissNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const notificationId = String(req.params.notificationId || '');

    const { count: deletedCount } = await prisma.notification.deleteMany({
      where: {
        id: notificationId,
        userId
      }
    });

    if (deletedCount === 0) {
      res.status(404).json({ success: false, message: 'Notification not found' });
      return;
    }

    res.json({ success: true, message: 'Notification dismissed' });
  } catch (error) {
    console.error('Error dismissing notification:', error);
    res.status(500).json({ success: false, message: 'Failed to dismiss notification' });
  }
};
