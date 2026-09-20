import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '../models/User';
import type { IUser } from '../models/User';
import prisma from '../config/prisma';

export interface AuthRequest extends Request {
  user?: IUser;
}

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ 
        success: false,
        message: 'No token, authorization denied',
        code: 'NO_TOKEN'
      });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not configured');
    }
    const decoded = jwt.verify(token, jwtSecret) as { userId: string };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        isVerified: true,
        admissionNumber: true,
        admissionYear: true,
        accountType: true,
        hasPremiumBadge: true,
        profileImage: true,
        bio: true,
        headline: true,
        city: true,
        country: true,
        company: true,
        jobTitle: true,
        contactEmail: true,
        contactPhone: true,
        linkedInProfile: true,
        location: true,
        needsManualVerification: true,
        notificationSettings: true,
        privacySettings: true,
        createdAt: true,
        updatedAt: true,
        lastLogin: true
      }
    });

    if (!user) {
      res.status(401).json({ 
        success: false,
        message: 'Token is not valid - user not found',
        code: 'INVALID_TOKEN'
      });
      return;
    }

    // Enhanced status checks for Phase 1
    const normalizedStatus = String(user.status || '').toLowerCase();

    if (normalizedStatus === 'suspended') {
      res.status(403).json({ 
        success: false,
        message: 'Account has been suspended. Please contact administrator.',
        code: 'ACCOUNT_SUSPENDED'
      });
      return;
    }

    if (normalizedStatus === 'deleted') {
      res.status(403).json({ 
        success: false,
        message: 'Account no longer exists',
        code: 'ACCOUNT_DELETED'
      });
      return;
    }

    if (normalizedStatus === 'pending') {
      res.status(403).json({ 
        success: false,
        message: 'Account is pending approval',
        code: 'ACCOUNT_PENDING'
      });
      return;
    }

    req.user = {
      ...(user as unknown as IUser),
      _id: user.id,
      role: String(user.role || '').toLowerCase(),
      status: normalizedStatus
    };
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ 
        success: false,
        message: 'Token has expired',
        code: 'TOKEN_EXPIRED'
      });
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ 
        success: false,
        message: 'Invalid token format',
        code: 'INVALID_TOKEN_FORMAT'
      });
      return;
    }

    res.status(401).json({ 
      success: false,
      message: 'Token is not valid',
      code: 'TOKEN_INVALID'
    });
  }
};

export const requireRole = (roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'Not authenticated' });
      return;
    }

    const normalizedUserRole = String(req.user.role || '').toLowerCase();
    const allowedRoles = roles.map((role) => String(role).toLowerCase());

    if (!allowedRoles.includes(normalizedUserRole)) {
      res.status(403).json({ message: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

export const requireSuperAdmin = requireRole([UserRole.SUPER_ADMIN]);
export const requireAdmin = requireRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
