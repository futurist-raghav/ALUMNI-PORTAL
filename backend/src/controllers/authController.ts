import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { Role, Status } from '@prisma/client';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/errorHandler';
import bcrypt from 'bcryptjs';

// Extend Express Request to include user
interface AuthRequest extends Request {
  user?: any;
}

const isBcryptHash = (value: string) => value.startsWith('$2a$') || value.startsWith('$2b$') || value.startsWith('$2y$');

const verifyPassword = async (inputPassword: string, storedPassword: string): Promise<boolean> => {
  if (!storedPassword) return false;

  if (isBcryptHash(storedPassword)) {
    return bcrypt.compare(inputPassword, storedPassword);
  }

  return inputPassword === storedPassword;
};

const toClientRole = (role: Role) => {
  if (role === Role.SUPER_ADMIN) return 'super_admin';
  if (String(role) === 'MODERATOR') return 'moderator';
  if (role === Role.ADMIN) return 'admin';
  return 'user';
};

const getAccountTypeLabel = (user: unknown) => {
  const value = (user as { accountType?: string } | undefined)?.accountType;
  return (value || 'ALUMNI').toLowerCase();
};

const hasPremiumBadge = (user: unknown) => Boolean((user as { hasPremiumBadge?: boolean } | undefined)?.hasPremiumBadge);

const normalizeEmail = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

const extractRefreshToken = (req: Request): string | null => {
  const cookieToken = req.cookies?.refreshToken;
  const bodyToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;
  const headerToken = typeof req.header('x-refresh-token') === 'string' ? req.header('x-refresh-token') : null;
  return bodyToken || headerToken || cookieToken || null;
};

const parseBrowserFromUserAgent = (userAgent: string): string => {
  const ua = userAgent.toLowerCase();

  if (ua.includes('edg/')) return 'Edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
  if (ua.includes('chrome/')) return 'Chrome';
  if (ua.includes('safari/') && !ua.includes('chrome/')) return 'Safari';
  if (ua.includes('firefox/')) return 'Firefox';

  return 'Unknown Browser';
};

const parseDeviceFromUserAgent = (userAgent: string): string => {
  const ua = userAgent.toLowerCase();

  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('android')) return 'Android Device';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'Mac Device';
  if (ua.includes('windows')) return 'Windows Device';
  if (ua.includes('linux')) return 'Linux Device';

  return 'Unknown Device';
};

const ACCESS_TOKEN_EXPIRES_IN =
  process.env.JWT_EXPIRES_IN ||
  process.env.JWT_EXPIRE ||
  '12h';

const REFRESH_TOKEN_EXPIRES_IN =
  process.env.JWT_REFRESH_EXPIRES_IN ||
  process.env.JWT_REFRESH_EXPIRE ||
  '30d';

const DEFAULT_REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_COOKIE_MAX_AGE_MS = Number(process.env.JWT_REFRESH_COOKIE_MAX_AGE_MS) || DEFAULT_REFRESH_COOKIE_MAX_AGE_MS;

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured');
  }
  return secret;
};

const getJwtRefreshSecret = (): string => {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET environment variable is not configured');
  }
  return secret;
};

const generateTokens = (userId: string) => {
  const payload = { userId };
  
  const accessToken = jwt.sign(
    payload, 
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN as NonNullable<SignOptions['expiresIn']> }
  );

  const refreshToken = jwt.sign(
    payload,
    getJwtRefreshSecret(),
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN as NonNullable<SignOptions['expiresIn']> }
  );

  return { accessToken, refreshToken };
};

export const register = asyncHandler(async (req: Request, res: Response) => {
  const {
    email,
    password,
    firstName,
    lastName,
    name,
    admissionNumber,
    admissionYear,
    graduationYear,
    needsManualVerification,
    forgotAdmissionNumber,
    verificationDetails,
    accountType,
    facultyIdCardUrl,
  } = req.body;

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    res.status(400).json({ success: false, message: 'Email is required' });
    return;
  }

  const normalizedAdmissionNumber =
    typeof admissionNumber === 'string' ? admissionNumber.trim() : '';

  const normalizedVerificationDetails = typeof verificationDetails === 'string' ? verificationDetails.trim() : '';
  const normalizedFacultyIdCardUrl = typeof facultyIdCardUrl === 'string' ? facultyIdCardUrl.trim() : '';
  const normalizedAccountType = String(accountType || '').toUpperCase();
  const resolvedAccountType = normalizedAccountType === 'FACULTY' ? 'FACULTY' : 'ALUMNI';

  const requiresManualVerification =
    resolvedAccountType === 'FACULTY' ||
    Boolean(needsManualVerification) ||
    Boolean(forgotAdmissionNumber) ||
    normalizedAdmissionNumber.length === 0;

  if (!requiresManualVerification && !normalizedAdmissionNumber) {
    res.status(400).json({ success: false, message: 'Admission number is required' });
    return;
  }

  if (requiresManualVerification && normalizedVerificationDetails.length < 10 && !normalizedFacultyIdCardUrl) {
    res.status(400).json({
      success: false,
      message: 'Please provide verification details (minimum 10 characters) or upload faculty ID card for manual verification.'
    });
    return;
  }

  const existingUser = await prisma.user.findFirst({
    where: {
      email: {
        equals: normalizedEmail,
        mode: 'insensitive'
      }
    }
  });
  if (existingUser) {
    res.status(400).json({ success: false, message: 'Email already registered' });
    return;
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const resolvedName = (name || [firstName, lastName].filter(Boolean).join(' ')).trim();
  const inferredAdmissionYear =
    admissionYear ||
    graduationYear ||
    (normalizedAdmissionNumber.includes('/')
      ? `20${normalizedAdmissionNumber.split('/').pop()}`
      : undefined) ||
    '';

  if (resolvedAccountType === 'FACULTY' && !normalizedFacultyIdCardUrl) {
    res.status(400).json({
      success: false,
      message: 'Faculty ID card photo is required for verification.'
    });
    return;
  }

  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      password: hashedPassword,
      role: Role.USER,
      name: resolvedName || normalizedEmail.split('@')[0],
      firstName,
      lastName,
      admissionNumber: normalizedAdmissionNumber || 'MANUAL_VERIFICATION',
      admissionYear: inferredAdmissionYear,
      accountType: resolvedAccountType,
      needsManualVerification: requiresManualVerification,
      verificationDetails: requiresManualVerification
        ? normalizedVerificationDetails || (resolvedAccountType === 'FACULTY' ? 'Faculty ID card submitted for verification.' : null)
        : null,
      facultyIdCardUrl: normalizedFacultyIdCardUrl || null,
      status: Status.PENDING,
    } as any,
  });

  res.status(201).json({
    success: true,
    message: 'Registration submitted. Your account is pending approval.',
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: toClientRole(user.role),
      accountType: getAccountTypeLabel(user),
      hasPremiumBadge: hasPremiumBadge(user),
      facultyIdCardUrl: (user as { facultyIdCardUrl?: string | null }).facultyIdCardUrl || undefined,
      admissionNumber: user.admissionNumber,
      admissionYear: user.admissionYear,
      status: user.status.toLowerCase(),
      isVerified: user.isVerified
    },
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: toClientRole(user.role),
        accountType: getAccountTypeLabel(user),
        hasPremiumBadge: hasPremiumBadge(user),
        facultyIdCardUrl: (user as { facultyIdCardUrl?: string | null }).facultyIdCardUrl || undefined,
        admissionNumber: user.admissionNumber,
        admissionYear: user.admissionYear,
        status: user.status.toLowerCase(),
        isVerified: user.isVerified
      },
      requiresApproval: true
    }
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
    return;
  }

  const user = await prisma.user.findFirst({
    where: {
      email: {
        equals: normalizedEmail,
        mode: 'insensitive'
      }
    }
  });

  if (!user) {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
    return;
  }

  const isMatch = await verifyPassword(password, user.password);
  if (!isMatch) {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
    return;
  }

  if (user.status === Status.PENDING) {
    res.status(403).json({
      success: false,
      message: 'Your account is pending approval by super admin/moderator.'
    });
    return;
  }

  if (user.status === Status.SUSPENDED || user.status === Status.DELETED) {
    res.status(403).json({
      success: false,
      message: 'Your account is not active. Please contact support.'
    });
    return;
  }

  // Automatically upgrade legacy plaintext passwords to bcrypt after successful login
  if (!isBcryptHash(user.password)) {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword }
    });
  }

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLogin: new Date() }
  });

  const { accessToken, refreshToken } = generateTokens(user.id);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokens: { push: refreshToken } }
  });

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS
  });

  res.status(200).json({
    success: true,
    message: 'Login successful',
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: toClientRole(user.role),
      accountType: getAccountTypeLabel(user),
      hasPremiumBadge: hasPremiumBadge(user),
      facultyIdCardUrl: (user as { facultyIdCardUrl?: string | null }).facultyIdCardUrl || undefined,
      admissionNumber: user.admissionNumber,
      admissionYear: user.admissionYear,
      status: user.status.toLowerCase(),
      isVerified: user.isVerified,
      profileImage: user.profileImage,
      bio: user.bio,
      headline: user.headline,
      city: user.city,
      country: user.country,
      company: user.company,
      jobTitle: user.jobTitle
    },
    accessToken,
    refreshToken,
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: toClientRole(user.role),
        accountType: getAccountTypeLabel(user),
        hasPremiumBadge: hasPremiumBadge(user),
        facultyIdCardUrl: (user as { facultyIdCardUrl?: string | null }).facultyIdCardUrl || undefined,
        admissionNumber: user.admissionNumber,
        admissionYear: user.admissionYear,
        status: user.status.toLowerCase(),
        isVerified: user.isVerified,
        profileImage: user.profileImage,
        bio: user.bio,
        headline: user.headline,
        city: user.city,
        country: user.country,
        company: user.company,
        jobTitle: user.jobTitle
      },
      accessToken
    }
  });
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const token = extractRefreshToken(req);
  
  if (!token) {
    res.status(401).json({ success: false, message: 'Refresh token not found' });
    return;
  }

  try {
    const decoded = jwt.verify(
      token, 
      getJwtRefreshSecret()
    ) as any;

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, refreshTokens: true }
    });

    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid refresh token' });
      return;
    }

    if (!Array.isArray(user.refreshTokens) || !user.refreshTokens.includes(token)) {
      res.status(401).json({ success: false, message: 'Refresh token has been revoked' });
      return;
    }

    const tokens = generateTokens(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        refreshTokens: user.refreshTokens.map((storedToken) =>
          storedToken === token ? tokens.refreshToken : storedToken
        )
      }
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS
    });

    res.status(200).json({
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
    });
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
});

export const logout = asyncHandler(async (req: AuthRequest, res: Response) => {
  const token = extractRefreshToken(req);

  if (req.user?.id && token) {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { refreshTokens: true }
    });

    if (user) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { refreshTokens: (user.refreshTokens || []).filter((storedToken) => storedToken !== token) }
      });
    }
  }

  res.clearCookie('refreshToken');
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

export const getActiveSessions = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user?.id) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const token = extractRefreshToken(req);
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { refreshTokens: true, lastLogin: true, updatedAt: true }
  });

  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const activeTokens = Array.isArray(user.refreshTokens) ? user.refreshTokens : [];
  const hasCurrentToken = Boolean(token && activeTokens.includes(token));
  const otherSessionsCount = hasCurrentToken
    ? Math.max(0, activeTokens.length - 1)
    : activeTokens.length;

  const userAgent = String(req.headers['user-agent'] || 'Unknown Device');
  const browser = parseBrowserFromUserAgent(userAgent);
  const device = parseDeviceFromUserAgent(userAgent);
  const lastActive = (user.lastLogin || user.updatedAt || new Date()).toISOString();

  const sessions = [
    {
      id: 'current',
      device,
      browser,
      location: 'Current Device',
      time: 'Current Session',
      lastActive,
      isCurrent: true,
    },
    ...Array.from({ length: otherSessionsCount }, (_, index) => ({
      id: `other-${index + 1}`,
      device: `Other Device ${index + 1}`,
      browser: 'Unknown',
      location: 'Unknown',
      time: 'Active',
      lastActive,
      isCurrent: false,
    })),
  ];

  res.status(200).json({
    success: true,
    data: {
      sessions,
      totalSessions: sessions.length,
      otherSessionsCount,
    }
  });
});

export const logoutOtherSessions = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user?.id) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const token = extractRefreshToken(req);
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { refreshTokens: true }
  });

  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const activeTokens = Array.isArray(user.refreshTokens) ? user.refreshTokens : [];
  const updatedTokens = token && activeTokens.includes(token) ? [token] : [];

  await prisma.user.update({
    where: { id: req.user.id },
    data: { refreshTokens: updatedTokens }
  });

  res.status(200).json({ success: true, message: 'Signed out from other devices' });
});

export const deactivateAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user?.id) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: { status: Status.DELETED, refreshTokens: [] }
  });

  res.clearCookie('refreshToken');
  res.status(200).json({ success: true, message: 'Account deactivated successfully' });
});

export const getMe = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id }
  });
  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  res.status(200).json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: toClientRole(user.role),
      accountType: getAccountTypeLabel(user),
      hasPremiumBadge: hasPremiumBadge(user),
      facultyIdCardUrl: (user as { facultyIdCardUrl?: string | null }).facultyIdCardUrl || undefined,
      admissionNumber: user.admissionNumber,
      admissionYear: user.admissionYear,
      status: user.status.toLowerCase(),
      isVerified: user.isVerified,
      profileImage: user.profileImage,
      bio: user.bio,
      headline: user.headline,
      city: user.city,
      country: user.country,
      contactEmail: user.contactEmail,
      contactPhone: user.contactPhone,
      linkedInProfile: user.linkedInProfile,
      company: user.company,
      jobTitle: user.jobTitle,
      isAvailableAsMentor: user.isAvailableAsMentor,
      location: user.location,
      experiences: (user as any).experiences ?? [],
      educations: (user as any).educations ?? [],
      skills: (user as any).skills ?? [],
      interests: (user as any).interests ?? [],
      notificationSettings: user.notificationSettings,
      privacySettings: user.privacySettings
    }
  });
});

export const uploadVerificationId = asyncHandler(async (req: Request & { file?: Express.Multer.File }, res: Response) => {
  if (!req.file) {
    res.status(400).json({ success: false, message: 'ID card image is required' });
    return;
  }

  if (!req.file.mimetype.startsWith('image/')) {
    res.status(400).json({ success: false, message: 'Only image files are allowed for faculty ID verification' });
    return;
  }

  res.status(200).json({
    success: true,
    message: 'ID card uploaded successfully',
    data: {
      url: `/api/uploads/${req.file.filename}`,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    }
  });
});

export const forgotPassword = asyncHandler(async (_req: Request, res: Response) => {
  // Stub for forgotten password logic
  res.status(200).json({ success: true, message: 'Password reset email sent' });
});

export const resetPassword = asyncHandler(async (_req: Request, res: Response) => {
  // Stub for reset password logic
  res.status(200).json({ success: true, message: 'Password has been reset' });
});

export const changePassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { currentPassword, newPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const isMatch = await verifyPassword(currentPassword, user.password);
  if (!isMatch) {
    res.status(400).json({ success: false, message: 'Invalid current password' });
    return;
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(newPassword, salt);

  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword }
  });

  res.status(200).json({ success: true, message: 'Password changed successfully' });
});

export const updateNotificationSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const settings = await prisma.user.update({
    where: { id: req.user.id },
    data: { notificationSettings: { ...(req.body || {}) } },
    select: { notificationSettings: true }
  });

  res.status(200).json({ success: true, data: settings.notificationSettings });
});

export const updatePrivacySettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const settings = await prisma.user.update({
    where: { id: req.user.id },
    data: { privacySettings: { ...(req.body || {}) } },
    select: { privacySettings: true }
  });

  res.status(200).json({ success: true, data: settings.privacySettings });
});
