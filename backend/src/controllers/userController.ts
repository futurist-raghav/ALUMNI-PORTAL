import { Request, Response } from 'express';
import { ConnectionRequestStatus, Prisma, Role, Status } from '@prisma/client';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/errorHandler';
import { getHiddenSystemAccountEmails, isHiddenSystemAccountEmail } from '../config/systemAccounts';
import { createNotification } from '../utils/notifications';

interface AuthRequest extends Request {
  user?: any;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const parsePositiveInt = (value: unknown, fallback: number) => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return fallback;
  }

  const parsed = Number.parseInt(`${value}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePagination = (pageInput: unknown, limitInput: unknown, fallbackLimit = DEFAULT_PAGE_SIZE) => {
  const page = parsePositiveInt(pageInput, 1);
  const limit = Math.min(parsePositiveInt(limitInput, fallbackLimit), MAX_PAGE_SIZE);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const adminUserSelect = {
  id: true,
  email: true,
  name: true,
  firstName: true,
  lastName: true,
  profileImage: true,
  role: true,
  status: true,
  admissionNumber: true,
  admissionYear: true,
  accountType: true,
  hasPremiumBadge: true,
  facultyIdCardUrl: true,
  needsManualVerification: true,
  verificationDetails: true,
  isVerified: true,
  createdAt: true,
  updatedAt: true,
  lastLogin: true,
  bio: true,
  headline: true,
  linkedInProfile: true,
  skills: true,
  contactEmail: true,
  contactPhone: true,
  city: true,
  country: true,
  company: true,
  jobTitle: true,
  location: true,
  isAvailableAsMentor: true
} as const;

const normalizeRole = (role?: string) => (role || '').toUpperCase();
const normalizeStatus = (status?: string) => (status || '').toUpperCase();

const serializeUser = (user: any) => ({
  ...user,
  role: typeof user?.role === 'string' ? user.role.toLowerCase() : user?.role,
  status: typeof user?.status === 'string' ? user.status.toLowerCase() : user?.status,
});

const isAdminRole = (role?: string) => {
  const normalized = normalizeRole(role);
  return normalized === 'MODERATOR' || normalized === 'ADMIN' || normalized === 'SUPER_ADMIN';
};

const isSuperAdminRole = (role?: string) => normalizeRole(role) === 'SUPER_ADMIN';

const hiddenSystemEmails = () => [...getHiddenSystemAccountEmails()];

const notHiddenSystemAccountsFilter = () => ({ notIn: hiddenSystemEmails() });

const getTargetUserId = (req: Request): string | undefined => {
  return (req.params as any).id || (req.params as any).userId;
};

const getAuthenticatedUserId = (req: AuthRequest): string | undefined => {
  const user = req.user;
  return user?.id || user?._id;
};

const isMissingDirectMessageTableError = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const tableName = typeof error.meta?.table === 'string' ? error.meta.table : '';
    return error.code === 'P2021' && tableName.includes('DirectMessage');
  }

  if (error instanceof Error) {
    return error.message.includes('DirectMessage') && error.message.includes('does not exist');
  }

  return false;
};

type DirectoryFacetType = 'industry' | 'graduationYear' | 'location';
type DirectoryFacetMetric = 'search_count' | 'match_count';

interface DirectoryAnalyticsTarget {
  admissionYear?: string | null | undefined;
  location?: string | null | undefined;
  industry?: string | null | undefined;
}

const DIRECTORY_FILTER_ANALYTICS_TABLE = 'directory_filter_analytics';
const MAX_DIRECTORY_FACET_VALUES = 8;

const defaultIndustryFilters = [
  'Technology',
  'Finance',
  'Healthcare',
  'Education',
  'Manufacturing',
  'Retail',
  'Consulting'
];

const defaultLocationFilters = [
  'San Francisco, CA',
  'New York, NY',
  'Austin, TX',
  'Chicago, IL',
  'Seattle, WA'
];

let directoryAnalyticsTableReady: Promise<void> | null = null;

const normalizeFacetValue = (value: string) => value.trim().replace(/\s+/g, ' ');

const mergeFacetValues = (
  analyticsValues: string[],
  dataValues: string[],
  fallbackValues: string[],
  maxValues = MAX_DIRECTORY_FACET_VALUES
) => {
  const seen = new Set<string>();
  const merged: string[] = [];

  const append = (candidate: string) => {
    const normalized = normalizeFacetValue(candidate);
    if (!normalized || seen.has(normalized)) return;

    seen.add(normalized);
    merged.push(normalized);
  };

  for (const value of analyticsValues) append(value);
  for (const value of dataValues) append(value);
  for (const value of fallbackValues) append(value);

  return merged.slice(0, maxValues);
};

const ensureDirectoryAnalyticsTable = async () => {
  directoryAnalyticsTableReady ??= prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ${DIRECTORY_FILTER_ANALYTICS_TABLE} (
        facet_type TEXT NOT NULL,
        facet_value TEXT NOT NULL,
        search_count INTEGER NOT NULL DEFAULT 0,
        match_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (facet_type, facet_value)
      )
    `)
      .then(() => undefined)
      .catch((error) => {
        directoryAnalyticsTableReady = null;
        throw error;
      });

  await directoryAnalyticsTableReady;
};

const incrementDirectoryFacetMetric = async (
  facetType: DirectoryFacetType,
  facetValue: string,
  metric: DirectoryFacetMetric,
  incrementBy = 1
) => {
  const normalizedValue = normalizeFacetValue(facetValue);
  if (!normalizedValue || incrementBy <= 0) return;

  await ensureDirectoryAnalyticsTable();
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO ${DIRECTORY_FILTER_ANALYTICS_TABLE} (facet_type, facet_value, ${metric}, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (facet_type, facet_value)
      DO UPDATE SET
        ${metric} = ${DIRECTORY_FILTER_ANALYTICS_TABLE}.${metric} + EXCLUDED.${metric},
        updated_at = NOW()
    `,
    facetType,
    normalizedValue,
    incrementBy
  );
};

const getDirectoryFacetAnalytics = async (facetType: DirectoryFacetType, limit = MAX_DIRECTORY_FACET_VALUES) => {
  try {
    await ensureDirectoryAnalyticsTable();

    const rows = await prisma.$queryRawUnsafe<Array<{ facet_value: string }>>(
      `
        SELECT facet_value
        FROM ${DIRECTORY_FILTER_ANALYTICS_TABLE}
        WHERE facet_type = $1
        ORDER BY (search_count * 2 + match_count) DESC, updated_at DESC
        LIMIT $2
      `,
      facetType,
      limit
    );

    return rows
      .map((row) => normalizeFacetValue(row.facet_value))
      .filter(Boolean);
  } catch (error) {
    console.warn('Unable to fetch directory analytics facets:', error);
    return [];
  }
};

const incrementFacetCounter = (counter: Map<string, number>, rawValue: string | null | undefined) => {
  if (!rawValue) return;

  const normalized = normalizeFacetValue(rawValue);
  if (!normalized) return;

  const previous = counter.get(normalized) ?? 0;
  counter.set(normalized, previous + 1);
};

const captureDirectorySearchAnalytics = async (
  filters: {
    search?: string;
    graduationYear?: string;
    location?: string;
    industry?: string;
  },
  results: DirectoryAnalyticsTarget[]
) => {
  try {
    const searchUpdates: Promise<unknown>[] = [];

    if (filters.graduationYear) {
      searchUpdates.push(incrementDirectoryFacetMetric('graduationYear', filters.graduationYear, 'search_count'));
    }

    if (filters.location) {
      searchUpdates.push(incrementDirectoryFacetMetric('location', filters.location, 'search_count'));
    }

    if (filters.industry) {
      searchUpdates.push(incrementDirectoryFacetMetric('industry', filters.industry, 'search_count'));
    }

    if (filters.search) {
      const yearMatches = filters.search.match(/\b(?:19|20)\d{2}\b/g) || [];
      for (const year of yearMatches) {
        searchUpdates.push(incrementDirectoryFacetMetric('graduationYear', year, 'search_count'));
      }
    }

    const yearMatches = new Map<string, number>();
    const locationMatches = new Map<string, number>();
    const industryMatches = new Map<string, number>();

    for (const result of results) {
      incrementFacetCounter(yearMatches, result.admissionYear ?? null);
      incrementFacetCounter(locationMatches, result.location ?? null);
      incrementFacetCounter(industryMatches, result.industry ?? null);
    }

    const matchUpdates: Promise<unknown>[] = [];

    for (const [value, count] of yearMatches.entries()) {
      matchUpdates.push(incrementDirectoryFacetMetric('graduationYear', value, 'match_count', count));
    }

    for (const [value, count] of locationMatches.entries()) {
      matchUpdates.push(incrementDirectoryFacetMetric('location', value, 'match_count', count));
    }

    for (const [value, count] of industryMatches.entries()) {
      matchUpdates.push(incrementDirectoryFacetMetric('industry', value, 'match_count', count));
    }

    await Promise.all([...searchUpdates, ...matchUpdates]);
  } catch (error) {
    console.warn('Unable to capture directory analytics:', error);
  }
};

export const getAllUsers = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);

  const { role, status, search } = req.query;
  const roleFilter = typeof role === 'string' ? role : undefined;
  const statusFilter = typeof status === 'string' ? status : undefined;

  const where: any = {};
  where.email = notHiddenSystemAccountsFilter();
  if (roleFilter) where.role = normalizeRole(roleFilter) as Role;
  if (statusFilter) where.status = normalizeStatus(statusFilter) as Status;
  if (search) {
    where.OR = [
      { email: { contains: search as string, mode: 'insensitive' } },
      { name: { contains: search as string, mode: 'insensitive' } },
      { firstName: { contains: search as string, mode: 'insensitive' } },
      { lastName: { contains: search as string, mode: 'insensitive' } }
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip, take: limit,
      orderBy: { createdAt: 'desc' },
      select: adminUserSelect
    }),
    prisma.user.count({ where })
  ]);

  const serializedUsers = users.map((user) => serializeUser(user));

  res.status(200).json({
    success: true, data: serializedUsers, users: serializedUsers,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const getPublicAlumni = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20);

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const graduationYear = typeof req.query.graduationYear === 'string' ? req.query.graduationYear.trim() : '';
  const company = typeof req.query.company === 'string' ? req.query.company.trim() : '';
  const location = typeof req.query.location === 'string' ? req.query.location.trim() : '';
  const industry = typeof req.query.industry === 'string' ? req.query.industry.trim() : '';
  const authReq = req as AuthRequest;
  const currentUserId = getAuthenticatedUserId(authReq);

  let connectedUserIds = new Set<string>();
  let pendingSentUserIds = new Set<string>();
  let pendingIncomingUserIds = new Set<string>();
  let followingUserIds = new Set<string>();

  if (currentUserId) {
    const currentUser = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: {
        connections: { select: { id: true } },
        connectedTo: { select: { id: true } },
        sentConnectionRequests: {
          where: { status: ConnectionRequestStatus.PENDING },
          select: { receiverId: true }
        },
        receivedConnectionRequests: {
          where: { status: ConnectionRequestStatus.PENDING },
          select: { senderId: true }
        },
        followingRelationships: { select: { followingId: true } }
      }
    });

    if (currentUser) {
      connectedUserIds = new Set([
        ...currentUser.connections.map((user) => user.id),
        ...currentUser.connectedTo.map((user) => user.id)
      ]);
      pendingSentUserIds = new Set(currentUser.sentConnectionRequests.map((request) => request.receiverId));
      pendingIncomingUserIds = new Set(currentUser.receivedConnectionRequests.map((request) => request.senderId));
      followingUserIds = new Set(currentUser.followingRelationships.map((relation) => relation.followingId));
    }
  }

  const where: Prisma.UserWhereInput = {
    status: Status.ACTIVE,
    email: notHiddenSystemAccountsFilter()
  };

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { headline: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
      { jobTitle: { contains: search, mode: 'insensitive' } },
      { mentorshipProfile: { is: { industry: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  if (graduationYear) {
    where.admissionYear = graduationYear;
  }
  if (company) where.company = { contains: company, mode: 'insensitive' };
  if (location) where.location = { contains: location, mode: 'insensitive' };
  if (industry) {
    where.mentorshipProfile = {
      is: {
        isActive: true,
        industry: { equals: industry, mode: 'insensitive' }
      }
    };
  }

  const [alumni, total, popularYears, popularLocations, popularIndustries] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: limit,
      select: {
        id: true,
        name: true,
        role: true,
        firstName: true,
        lastName: true,
        profileImage: true,
        headline: true,
        jobTitle: true,
        company: true,
        location: true,
        admissionYear: true,
        bio: true,
        mentorshipProfile: {
          select: {
            industry: true,
          }
        }
      }
    }),
    prisma.user.count({ where }),
    prisma.user.groupBy({
      by: ['admissionYear'],
      where: {
        status: Status.ACTIVE,
        email: notHiddenSystemAccountsFilter(),
        NOT: { admissionYear: '' }
      },
      _count: {
        admissionYear: true
      },
      orderBy: {
        _count: {
          admissionYear: 'desc'
        }
      },
      take: MAX_DIRECTORY_FACET_VALUES
    }),
    prisma.user.groupBy({
      by: ['location'],
      where: {
        status: Status.ACTIVE,
        email: notHiddenSystemAccountsFilter(),
        location: { not: null },
        NOT: { location: '' }
      },
      _count: {
        location: true
      },
      orderBy: {
        _count: {
          location: 'desc'
        }
      },
      take: MAX_DIRECTORY_FACET_VALUES
    }),
    prisma.mentorshipProfile.groupBy({
      by: ['industry'],
      where: {
        isActive: true,
        industry: { not: null },
        user: {
          status: Status.ACTIVE,
          email: notHiddenSystemAccountsFilter()
        }
      },
      _count: {
        industry: true
      },
      orderBy: {
        _count: {
          industry: 'desc'
        }
      },
      take: MAX_DIRECTORY_FACET_VALUES
    })
  ]);

  const alumniWithConnectionStatus = alumni
    .filter((user) => user.id !== currentUserId)
    .map((user) => {
      let connectionStatus: 'none' | 'pending' | 'incoming' | 'connected' = 'none';

      const profileIndustry = user.mentorshipProfile?.industry ? normalizeFacetValue(user.mentorshipProfile.industry) : undefined;

      if (connectedUserIds.has(user.id)) {
        connectionStatus = 'connected';
      } else if (pendingIncomingUserIds.has(user.id)) {
        connectionStatus = 'incoming';
      } else if (pendingSentUserIds.has(user.id)) {
        connectionStatus = 'pending';
      }

      return {
        ...user,
        connectionStatus,
        isFollowing: followingUserIds.has(user.id),
        industry: profileIndustry,
      };
    });

  const [analyticsIndustries, analyticsYears, analyticsLocations] = await Promise.all([
    getDirectoryFacetAnalytics('industry'),
    getDirectoryFacetAnalytics('graduationYear'),
    getDirectoryFacetAnalytics('location')
  ]);

  const dataIndustryValues = popularIndustries
    .map((item) => item.industry)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeFacetValue(value));

  const dataYearValues = popularYears
    .map((item) => normalizeFacetValue(item.admissionYear))
    .filter((value) => /^\d{4}$/.test(value));

  const dataLocationValues = popularLocations
    .map((item) => item.location)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeFacetValue(value));

  const mergedIndustryValues = mergeFacetValues(analyticsIndustries, dataIndustryValues, defaultIndustryFilters);
  const mergedYearValues = mergeFacetValues(analyticsYears, dataYearValues, []);
  const mergedLocationValues = mergeFacetValues(analyticsLocations, dataLocationValues, defaultLocationFilters);

  const graduationYearsFromFacets = mergedYearValues
    .map((year) => Number.parseInt(year, 10))
    .filter((year) => Number.isInteger(year) && year > 1900 && year < 3000)
    .slice(0, MAX_DIRECTORY_FACET_VALUES);

  const fallbackYears = Array.from({ length: 10 }, (_, index) => new Date().getFullYear() - index);

  const analyticsFilters: {
    search?: string;
    graduationYear?: string;
    location?: string;
    industry?: string;
  } = {};

  if (search) analyticsFilters.search = search;
  if (graduationYear) analyticsFilters.graduationYear = graduationYear;
  if (location) analyticsFilters.location = location;
  if (industry) analyticsFilters.industry = industry;

  await captureDirectorySearchAnalytics(
    analyticsFilters,
    alumniWithConnectionStatus.map((alumniUser) => ({
      admissionYear: alumniUser.admissionYear,
      location: alumniUser.location,
      industry: alumniUser.industry,
    }))
  );

  res.status(200).json({
    success: true, data: alumniWithConnectionStatus,
    filters: {
      industries: mergedIndustryValues,
      graduationYears: graduationYearsFromFacets.length > 0 ? graduationYearsFromFacets : fallbackYears.slice(0, MAX_DIRECTORY_FACET_VALUES),
      locations: mergedLocationValues,
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const searchDirectMessageUsers = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  const requestedLimit = parsePositiveInt(req.query.limit, 20);
  const limit = Math.min(Math.max(requestedLimit, 1), 50);
  const textMatchFilter = { contains: query, mode: Prisma.QueryMode.insensitive };

  const searchConditions: Prisma.UserWhereInput[] = [];
  if (query) {
    searchConditions.push({
      OR: [
        { name: textMatchFilter },
        { email: textMatchFilter },
        { headline: textMatchFilter },
        { company: textMatchFilter },
        { jobTitle: textMatchFilter },
        { location: textMatchFilter }
      ]
    });
  }

  const messageableUsers = await prisma.user.findMany({
    where: {
      status: Status.ACTIVE,
      email: notHiddenSystemAccountsFilter(),
      id: { not: currentUserId },
      AND: [
        {
          OR: [
            { connections: { some: { id: currentUserId } } },
            { connectedTo: { some: { id: currentUserId } } }
          ]
        },
        ...searchConditions
      ]
    },
    select: {
      id: true,
      name: true,
      email: true,
      profileImage: true,
      headline: true,
      jobTitle: true,
      company: true,
      location: true,
    },
    orderBy: [
      { name: 'asc' }
    ],
    take: limit
  });

  const results = messageableUsers.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage,
    headline: user.headline || user.jobTitle || undefined,
    company: user.company,
    location: user.location,
  }));

  res.status(200).json({ success: true, data: results });
});

export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: String(id) },
    select: {
      id: true,
      email: true,
      name: true,
      firstName: true,
      lastName: true,
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
      admissionNumber: true,
      admissionYear: true,
      accountType: true,
      role: true,
      status: true,
      isVerified: true,
      isAvailableAsMentor: true,
      notificationSettings: true,
      privacySettings: true,
      experiences: true,
      educations: true,
      skills: true,
      interests: true,
      mentorshipProfile: {
        select: {
          id: true,
          isMentor: true,
          isActive: true,
          expertise: true,
          availability: true,
          communicationPreferences: true
        }
      }
    }
  });

  const authReq = req as AuthRequest;
  const currentUserId = getAuthenticatedUserId(authReq);

  if (!user || (isHiddenSystemAccountEmail(user.email) && currentUserId !== user.id)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  let connectionStatus: 'none' | 'pending' | 'incoming' | 'connected' = 'none';

  if (currentUserId && currentUserId !== user.id) {
    const [isConnected, sentPending, incomingPending] = await Promise.all([
      prisma.user.findFirst({
        where: {
          id: currentUserId,
          OR: [
            { connections: { some: { id: user.id } } },
            { connectedTo: { some: { id: user.id } } }
          ]
        },
        select: { id: true }
      }),
      prisma.connectionRequest.findFirst({
        where: {
          senderId: currentUserId,
          receiverId: user.id,
          status: ConnectionRequestStatus.PENDING
        },
        select: { id: true }
      }),
      prisma.connectionRequest.findFirst({
        where: {
          senderId: user.id,
          receiverId: currentUserId,
          status: ConnectionRequestStatus.PENDING
        },
        select: { id: true }
      })
    ]);

    if (isConnected) {
      connectionStatus = 'connected';
    } else if (incomingPending) {
      connectionStatus = 'incoming';
    } else if (sentPending) {
      connectionStatus = 'pending';
    }
  }

  res.status(200).json({
    success: true,
    data: serializeUser({ ...user, connectionStatus })
  });
});

export const getUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      firstName: true,
      lastName: true,
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
      privacySettings: true,
      notificationSettings: true
    }
  });

  const authReq = req as AuthRequest;
  const currentUserId = getAuthenticatedUserId(authReq);

  if (!user || (isHiddenSystemAccountEmail((user as { email?: string | null }).email) && currentUserId !== user.id)) {
    res.status(404).json({ success: false, message: 'Profile not found' });
    return;
  }
  const profileData = { ...user } as Record<string, unknown>;
  delete profileData.email;

  res.status(200).json({ success: true, data: profileData });
});

export const updateProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (req.user.id !== id && !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  // Prevent mass assignment by strictly whitelisting editable profile fields
  const allowedFields = [
    'name',
    'firstName',
    'lastName',
    'bio',
    'headline',
    'city',
    'country',
    'company',
    'jobTitle',
    'contactEmail',
    'contactPhone',
    'linkedInProfile',
    'location',
    'isAvailableAsMentor',
    'experiences',
    'educations',
    'skills',
    'interests',
    'profileImage',
    'notificationSettings',
    'privacySettings'
  ];

  const updateData: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (req.body && req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  }

  const profile = await prisma.user.update({
    where: { id: String(id) },
    data: updateData as any
  });

  res.status(200).json({ success: true, data: serializeUser(profile) });
});

export const approveUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: { status: Status.ACTIVE },
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const rejectUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: { status: Status.DELETED },
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const blockUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: { status: Status.SUSPENDED },
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const deleteUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  await prisma.user.delete({ where: { id } });
  res.status(200).json({ success: true, data: {} });
});

export const getUserStats = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const hiddenEmailFilter = { email: notHiddenSystemAccountsFilter() };

  const [total, active, pending, suspended, moderatorUsers, adminUsers, superAdminUsers, recentRegistrations] = await Promise.all([
    prisma.user.count({ where: hiddenEmailFilter }),
    prisma.user.count({ where: { ...hiddenEmailFilter, status: Status.ACTIVE } }),
    prisma.user.count({ where: { ...hiddenEmailFilter, status: Status.PENDING } }),
    prisma.user.count({ where: { ...hiddenEmailFilter, status: Status.SUSPENDED } }),
    prisma.user.count({ where: { ...hiddenEmailFilter, role: 'MODERATOR' as Role } }),
    prisma.user.count({ where: { ...hiddenEmailFilter, role: Role.ADMIN } }),
    prisma.user.count({ where: { ...hiddenEmailFilter, role: Role.SUPER_ADMIN } }),
    prisma.user.count({ where: { ...hiddenEmailFilter, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } })
  ]);

  const stats = {
    totalUsers: total,
    activeUsers: active,
    pendingUsers: pending,
    suspendedUsers: suspended,
    moderatorUsers,
    adminUsers,
    superAdminUsers,
    recentRegistrations,
    totalJobs: 0,
    totalGroups: 0,
    totalPosts: 0
  };

  res.status(200).json({ success: true, data: stats, stats });
});

export const connectUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  const targetUserId = getTargetUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'Target user ID is required' });
    return;
  }

  if (currentUserId === targetUserId) {
    res.status(400).json({ success: false, message: 'Cannot connect with yourself' });
    return;
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, status: true, email: true }
  });

  if (targetUser?.status !== Status.ACTIVE || (targetUser.email && isHiddenSystemAccountEmail(targetUser.email))) {
    res.status(404).json({ success: false, message: 'Target user not found or inactive' });
    return;
  }

  const alreadyConnected = await prisma.user.findFirst({
    where: {
      id: currentUserId,
      OR: [
        { connections: { some: { id: targetUserId } } },
        { connectedTo: { some: { id: targetUserId } } }
      ]
    },
    select: { id: true }
  });

  if (alreadyConnected) {
    res.status(200).json({ success: true, message: 'Already connected', data: { connectionStatus: 'connected' } });
    return;
  }

  const incomingPendingRequest = await prisma.connectionRequest.findFirst({
    where: {
      senderId: targetUserId,
      receiverId: currentUserId,
      status: ConnectionRequestStatus.PENDING
    },
    select: { id: true }
  });

  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { id: true, name: true }
  });

  if (incomingPendingRequest) {
    await prisma.$transaction([
      prisma.connectionRequest.update({
        where: { id: incomingPendingRequest.id },
        data: { status: ConnectionRequestStatus.ACCEPTED, respondedAt: new Date() }
      }),
      prisma.user.update({
        where: { id: currentUserId },
        data: { connections: { connect: { id: targetUserId } } }
      }),
      prisma.user.update({
        where: { id: targetUserId },
        data: { connections: { connect: { id: currentUserId } } }
      })
    ]);

    await createNotification({
      userId: targetUserId,
      title: 'Connection accepted',
      message: `${currentUser?.name || 'A user'} accepted your connection request.`,
      type: 'connection',
      actionUrl: `/directory/profile/${currentUserId}`,
      metadata: { userId: currentUserId, event: 'connection_accepted' }
    });

    res.status(200).json({
      success: true,
      message: 'Connection request accepted successfully',
      data: { connectionStatus: 'connected' }
    });
    return;
  }

  const outgoingPendingRequest = await prisma.connectionRequest.findFirst({
    where: {
      senderId: currentUserId,
      receiverId: targetUserId,
      status: ConnectionRequestStatus.PENDING
    },
    select: { id: true }
  });

  if (outgoingPendingRequest) {
    res.status(200).json({
      success: true,
      message: 'Connection request already pending',
      data: { connectionStatus: 'pending' }
    });
    return;
  }

  await prisma.connectionRequest.upsert({
    where: {
      senderId_receiverId: {
        senderId: currentUserId,
        receiverId: targetUserId
      }
    },
    update: {
      status: ConnectionRequestStatus.PENDING,
      respondedAt: null
    },
    create: {
      senderId: currentUserId,
      receiverId: targetUserId,
      status: ConnectionRequestStatus.PENDING
    }
  });

  await createNotification({
    userId: targetUserId,
    title: 'New connection request',
    message: `${currentUser?.name || 'A user'} sent you a connection request.`,
    type: 'connection',
    actionUrl: `/directory/profile/${currentUserId}`,
    metadata: { userId: currentUserId, event: 'connection_request' }
  });

  res.status(200).json({
    success: true,
    message: 'Connection request sent successfully',
    data: { connectionStatus: 'pending' }
  });
});

export const acceptConnectionRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  const targetUserId = getTargetUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'Target user ID is required' });
    return;
  }

  const pendingRequest = await prisma.connectionRequest.findFirst({
    where: {
      senderId: targetUserId,
      receiverId: currentUserId,
      status: ConnectionRequestStatus.PENDING
    },
    select: { id: true }
  });

  if (!pendingRequest) {
    res.status(404).json({ success: false, message: 'No pending request from this user' });
    return;
  }

  await prisma.$transaction([
    prisma.connectionRequest.update({
      where: { id: pendingRequest.id },
      data: { status: ConnectionRequestStatus.ACCEPTED, respondedAt: new Date() }
    }),
    prisma.user.update({
      where: { id: currentUserId },
      data: { connections: { connect: { id: targetUserId } } }
    }),
    prisma.user.update({
      where: { id: targetUserId },
      data: { connections: { connect: { id: currentUserId } } }
    })
  ]);

  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { id: true, name: true }
  });

  await createNotification({
    userId: targetUserId,
    title: 'Connection accepted',
    message: `${currentUser?.name || 'A user'} accepted your connection request.`,
    type: 'connection',
    actionUrl: `/directory/profile/${currentUserId}`,
    metadata: { userId: currentUserId, event: 'connection_accepted' }
  });

  res.status(200).json({
    success: true,
    message: 'Connection accepted successfully',
    data: { connectionStatus: 'connected' }
  });
});

export const disconnectUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  const targetUserId = getTargetUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'Target user ID is required' });
    return;
  }

  if (currentUserId === targetUserId) {
    res.status(400).json({ success: false, message: 'Cannot disconnect from yourself' });
    return;
  }

  const isConnected = await prisma.user.findFirst({
    where: {
      id: currentUserId,
      OR: [
        { connections: { some: { id: targetUserId } } },
        { connectedTo: { some: { id: targetUserId } } }
      ]
    },
    select: { id: true }
  });

  const operations: any[] = [
    prisma.connectionRequest.deleteMany({
      where: {
        OR: [
          {
            senderId: currentUserId,
            receiverId: targetUserId,
            status: ConnectionRequestStatus.PENDING
          },
          {
            senderId: targetUserId,
            receiverId: currentUserId,
            status: ConnectionRequestStatus.PENDING
          }
        ]
      }
    })
  ];

  if (isConnected) {
    operations.push(
      prisma.user.update({
        where: { id: currentUserId },
        data: { connections: { disconnect: { id: targetUserId } } }
      }),
      prisma.user.update({
        where: { id: targetUserId },
        data: { connections: { disconnect: { id: currentUserId } } }
      })
    );
  }

  await prisma.$transaction(operations);

  res.status(200).json({
    success: true,
    message: isConnected ? 'Disconnected successfully' : 'Connection request removed',
    data: { connectionStatus: 'none' }
  });
});

export const followUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  const targetUserId = getTargetUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'Target user ID is required' });
    return;
  }

  if (currentUserId === targetUserId) {
    res.status(400).json({ success: false, message: 'Cannot follow yourself' });
    return;
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, status: true, email: true }
  });

  if (targetUser?.status !== Status.ACTIVE || (targetUser.email && isHiddenSystemAccountEmail(targetUser.email))) {
    res.status(404).json({ success: false, message: 'Target user not found or inactive' });
    return;
  }

  await prisma.follow.upsert({
    where: {
      followerId_followingId: {
        followerId: currentUserId,
        followingId: targetUserId
      }
    },
    update: {},
    create: {
      followerId: currentUserId,
      followingId: targetUserId
    }
  });

  res.status(200).json({ success: true, message: 'Now following user', data: { isFollowing: true } });
});

export const unfollowUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  const targetUserId = getTargetUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'Target user ID is required' });
    return;
  }

  await prisma.follow.deleteMany({
    where: {
      followerId: currentUserId,
      followingId: targetUserId
    }
  });

  res.status(200).json({ success: true, message: 'Unfollowed user', data: { isFollowing: false } });
});

export const getDirectConversations = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let messages: Array<{
    id: string;
    senderId: string;
    receiverId: string;
    content: string;
    isRead: boolean;
    createdAt: Date;
  }> = [];

  try {
    messages = await prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: currentUserId },
          { receiverId: currentUserId }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        content: true,
        isRead: true,
        createdAt: true
      }
    });
  } catch (error) {
    if (isMissingDirectMessageTableError(error)) {
      res.status(200).json({
        success: true,
        data: [],
        message: 'Direct messaging is not available yet. Please run the latest backend database migrations.'
      });
      return;
    }

    throw error;
  }

  const conversationMap = new Map<string, {
    userId: string;
    lastMessage: string;
    lastMessageAt: Date;
    lastMessageFromMe: boolean;
    unreadCount: number;
  }>();

  for (const message of messages) {
    const otherUserId = message.senderId === currentUserId ? message.receiverId : message.senderId;
    const existing = conversationMap.get(otherUserId);

    if (!existing) {
      conversationMap.set(otherUserId, {
        userId: otherUserId,
        lastMessage: message.content,
        lastMessageAt: message.createdAt,
        lastMessageFromMe: message.senderId === currentUserId,
        unreadCount: message.receiverId === currentUserId && !message.isRead ? 1 : 0
      });
      continue;
    }

    if (message.receiverId === currentUserId && !message.isRead) {
      existing.unreadCount += 1;
      conversationMap.set(otherUserId, existing);
    }
  }

  const participantIds = [...conversationMap.keys()];
  const participants = participantIds.length > 0
    ? await prisma.user.findMany({
      where: { id: { in: participantIds } },
      select: { id: true, name: true, profileImage: true, status: true, email: true }
    })
    : [];

  const participantById = new Map(participants.map((user) => [user.id, user]));

  const conversations = [...conversationMap.values()]
    .map((conversation) => {
      const participant = participantById.get(conversation.userId);
      if (participant?.status !== Status.ACTIVE || (participant.email && isHiddenSystemAccountEmail(participant.email))) {
        return null;
      }

      return {
        ...conversation,
        participant: {
          id: participant.id,
          name: participant.name,
          profileImage: participant.profileImage
        }
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.lastMessageAt.getTime() - left.lastMessageAt.getTime());

  res.status(200).json({ success: true, data: conversations });
});

export const getDirectMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  const targetUserId = getTargetUserId(req);

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'Target user ID is required' });
    return;
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, email: true }
  });

  if (!targetUser || isHiddenSystemAccountEmail(targetUser.email)) {
    res.status(404).json({ success: false, message: 'Target user not found' });
    return;
  }

  const areConnected = await prisma.user.findFirst({
    where: {
      id: currentUserId,
      OR: [
        { connections: { some: { id: targetUserId } } },
        { connectedTo: { some: { id: targetUserId } } }
      ]
    },
    select: { id: true }
  });

  if (!areConnected) {
    res.status(403).json({ success: false, message: 'You can only message connected users' });
    return;
  }

  let messages: Array<{
    id: string;
    senderId: string;
    receiverId: string;
    content: string;
    isRead: boolean;
    createdAt: Date;
  }> = [];

  try {
    messages = await prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: currentUserId, receiverId: targetUserId },
          { senderId: targetUserId, receiverId: currentUserId }
        ]
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        content: true,
        isRead: true,
        createdAt: true
      }
    });

    await prisma.directMessage.updateMany({
      where: {
        senderId: targetUserId,
        receiverId: currentUserId,
        isRead: false
      },
      data: {
        isRead: true,
        readAt: new Date()
      }
    });
  } catch (error) {
    if (isMissingDirectMessageTableError(error)) {
      res.status(200).json({
        success: true,
        data: [],
        message: 'Direct messaging is not available yet. Please run the latest backend database migrations.'
      });
      return;
    }

    throw error;
  }

  res.status(200).json({ success: true, data: messages });
});

export const sendDirectMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  const targetUserId = getTargetUserId(req);
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'Target user ID is required' });
    return;
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, email: true }
  });

  if (!targetUser || isHiddenSystemAccountEmail(targetUser.email)) {
    res.status(404).json({ success: false, message: 'Target user not found' });
    return;
  }

  if (currentUserId === targetUserId) {
    res.status(400).json({ success: false, message: 'Cannot message yourself' });
    return;
  }

  if (!content) {
    res.status(400).json({ success: false, message: 'Message content is required' });
    return;
  }

  if (content.length > 2000) {
    res.status(400).json({ success: false, message: 'Message content must not exceed 2000 characters' });
    return;
  }

  const areConnected = await prisma.user.findFirst({
    where: {
      id: currentUserId,
      OR: [
        { connections: { some: { id: targetUserId } } },
        { connectedTo: { some: { id: targetUserId } } }
      ]
    },
    select: { id: true }
  });

  if (!areConnected) {
    res.status(403).json({ success: false, message: 'You can only message connected users' });
    return;
  }

  let message: {
    id: string;
    senderId: string;
    receiverId: string;
    content: string;
    isRead: boolean;
    createdAt: Date;
  };

  try {
    message = await prisma.directMessage.create({
      data: {
        senderId: currentUserId,
        receiverId: targetUserId,
        content
      },
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        content: true,
        isRead: true,
        createdAt: true
      }
    });
  } catch (error) {
    if (isMissingDirectMessageTableError(error)) {
      res.status(503).json({
        success: false,
        message: 'Direct messaging is not available yet. Please run the latest backend database migrations.'
      });
      return;
    }

    throw error;
  }

  res.status(201).json({ success: true, message: 'Message sent', data: message });
});

export const getConnectionSuggestions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const currentUserId = getAuthenticatedUserId(req);
  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const requestedLimit = Number.parseInt(req.query.limit as string) || 8;
  const limit = Math.min(Math.max(requestedLimit, 1), 20);

  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: {
      company: true,
      location: true,
      admissionYear: true,
      connections: { select: { id: true } },
      connectedTo: { select: { id: true } }
    }
  });

  if (!currentUser) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const excludedIds = new Set<string>([
    currentUserId,
    ...currentUser.connections.map((user) => user.id),
    ...currentUser.connectedTo.map((user) => user.id)
  ]);

  const candidates = await prisma.user.findMany({
    where: {
      status: Status.ACTIVE,
      id: { notIn: [...excludedIds] },
      email: notHiddenSystemAccountsFilter()
    },
    select: {
      id: true,
      name: true,
      firstName: true,
      lastName: true,
      profileImage: true,
      headline: true,
      jobTitle: true,
      company: true,
      location: true,
      admissionYear: true,
      bio: true,
      createdAt: true
    },
    take: 50
  });

  const suggestions = candidates
    .map((candidate) => {
      let score = 0;

      if (candidate.company) score += 2;
      if (candidate.location) score += 2;
      if (candidate.headline || candidate.jobTitle) score += 2;
      if (candidate.bio) score += 1;

      if (currentUser.company?.toLowerCase() === candidate.company?.toLowerCase()) {
        score += 5;
      }

      if (currentUser.location?.toLowerCase() === candidate.location?.toLowerCase()) {
        score += 4;
      }

      if (currentUser.admissionYear && candidate.admissionYear && currentUser.admissionYear === candidate.admissionYear) {
        score += 3;
      }

      return {
        ...candidate,
        score,
        connectionStatus: 'none'
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  res.status(200).json({ success: true, data: suggestions });
});

export const searchAlumni = asyncHandler(async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: [] });
});

export const getPendingUsers = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);

  const where = { status: Status.PENDING, email: notHiddenSystemAccountsFilter() };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: adminUserSelect
    }),
    prisma.user.count({ where })
  ]);

  const serializedUsers = users.map((user) => serializeUser(user));

  res.status(200).json({
    success: true,
    data: serializedUsers,
    users: serializedUsers,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const suspendUser = blockUser;

export const reactivateUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: { status: Status.ACTIVE },
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const promoteToAdmin = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isSuperAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: { role: Role.ADMIN },
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const promoteToModerator = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isSuperAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: { role: 'MODERATOR' as Role },
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const demoteAdmin = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isSuperAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const targetUser = await prisma.user.findUnique({ where: { id }, select: { role: true, email: true } });

  if (!targetUser || isHiddenSystemAccountEmail(targetUser.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const nextRole = String(targetUser.role) === 'ADMIN' ? ('MODERATOR' as Role) : Role.USER;

  const user = await prisma.user.update({
    where: { id },
    data: { role: nextRole },
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const setPremiumBadge = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isSuperAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Only super admin can assign premium badge' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : true;

  const user = await prisma.user.update({
    where: { id },
    data: { hasPremiumBadge: enabled } as any,
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const adminEditUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = getTargetUserId(req);
  if (!id) {
    res.status(400).json({ success: false, message: 'User ID is required' });
    return;
  }

  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target || isHiddenSystemAccountEmail(target.email)) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  // Define allowed fields that can be edited by admins
  const { email, firstName, lastName, name, admissionNumber, admissionYear, accountType, contactEmail, contactPhone, city, country, company, jobTitle, location, isAvailableAsMentor, bio, headline, linkedInProfile, skills, status, role, isVerified, hasPremiumBadge } = req.body;

  const updateData: any = {};
  const isSuperAdmin = isSuperAdminRole(req.user.role);

  // Validate and add fields to update
  if (email !== undefined) {
    if (typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ success: false, message: 'Invalid email format' });
      return;
    }
    // Check if email is already in use by another user
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser && existingUser.id !== id) {
      res.status(400).json({ success: false, message: 'Email already in use' });
      return;
    }
    updateData.email = email;
  }

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2) {
      res.status(400).json({ success: false, message: 'Name must be at least 2 characters' });
      return;
    }
    updateData.name = name;
  }

  if (firstName !== undefined) {
    if (firstName !== null && typeof firstName !== 'string') {
      res.status(400).json({ success: false, message: 'First name must be string or null' });
      return;
    }
    updateData.firstName = typeof firstName === 'string' ? firstName.trim() || null : null;
  }

  if (lastName !== undefined) {
    if (lastName !== null && typeof lastName !== 'string') {
      res.status(400).json({ success: false, message: 'Last name must be string or null' });
      return;
    }
    updateData.lastName = typeof lastName === 'string' ? lastName.trim() || null : null;
  }

  if (admissionNumber !== undefined) {
    if (typeof admissionNumber !== 'string' || admissionNumber.trim().length === 0) {
      res.status(400).json({ success: false, message: 'Admission number is required' });
      return;
    }
    updateData.admissionNumber = admissionNumber;
  }

  if (admissionYear !== undefined) {
    if (typeof admissionYear !== 'string' || admissionYear.trim().length === 0) {
      res.status(400).json({ success: false, message: 'Admission year is required' });
      return;
    }
    updateData.admissionYear = admissionYear;
  }

  if (accountType !== undefined) {
    if (accountType && !['ALUMNI', 'FACULTY', 'STUDENT'].includes(accountType.toUpperCase())) {
      res.status(400).json({ success: false, message: 'Invalid account type' });
      return;
    }
    updateData.accountType = accountType?.toUpperCase() || 'ALUMNI';
  }

  if (contactEmail !== undefined) {
    if (contactEmail !== null && typeof contactEmail !== 'string') {
      res.status(400).json({ success: false, message: 'Contact email must be string or null' });
      return;
    }

    if (typeof contactEmail === 'string') {
      const normalizedContactEmail = contactEmail.trim();
      if (normalizedContactEmail.length > 0 && !normalizedContactEmail.includes('@')) {
        res.status(400).json({ success: false, message: 'Invalid contact email format' });
        return;
      }
      updateData.contactEmail = normalizedContactEmail || null;
    } else {
      updateData.contactEmail = null;
    }
  }

  if (contactPhone !== undefined) {
    if (contactPhone !== null && typeof contactPhone !== 'string') {
      res.status(400).json({ success: false, message: 'Contact phone must be string or null' });
      return;
    }
    updateData.contactPhone = contactPhone || null;
  }

  if (city !== undefined) {
    if (city !== null && typeof city !== 'string') {
      res.status(400).json({ success: false, message: 'City must be string or null' });
      return;
    }
    updateData.city = typeof city === 'string' ? city.trim() || null : null;
  }

  if (country !== undefined) {
    if (country !== null && typeof country !== 'string') {
      res.status(400).json({ success: false, message: 'Country must be string or null' });
      return;
    }
    updateData.country = typeof country === 'string' ? country.trim() || null : null;
  }

  if (company !== undefined) {
    if (company !== null && typeof company !== 'string') {
      res.status(400).json({ success: false, message: 'Company must be string or null' });
      return;
    }
    updateData.company = typeof company === 'string' ? company.trim() || null : null;
  }

  if (jobTitle !== undefined) {
    if (jobTitle !== null && typeof jobTitle !== 'string') {
      res.status(400).json({ success: false, message: 'Job title must be string or null' });
      return;
    }
    updateData.jobTitle = typeof jobTitle === 'string' ? jobTitle.trim() || null : null;
  }

  if (location !== undefined) {
    if (location !== null && typeof location !== 'string') {
      res.status(400).json({ success: false, message: 'Location must be string or null' });
      return;
    }
    updateData.location = typeof location === 'string' ? location.trim() || null : null;
  }

  if (isAvailableAsMentor !== undefined) {
    if (typeof isAvailableAsMentor !== 'boolean') {
      res.status(400).json({ success: false, message: 'isAvailableAsMentor must be boolean' });
      return;
    }
    updateData.isAvailableAsMentor = isAvailableAsMentor;
  }

  // Additional fields for professional/personal information
  if (bio !== undefined) {
    if (bio !== null && typeof bio !== 'string') {
      res.status(400).json({ success: false, message: 'Bio must be string or null' });
      return;
    }
    updateData.bio = typeof bio === 'string' ? bio.trim() || null : null;
  }

  if (headline !== undefined) {
    if (headline !== null && typeof headline !== 'string') {
      res.status(400).json({ success: false, message: 'Headline must be string or null' });
      return;
    }
    updateData.headline = typeof headline === 'string' ? headline.trim() || null : null;
  }

  if (linkedInProfile !== undefined) {
    if (linkedInProfile !== null && typeof linkedInProfile !== 'string') {
      res.status(400).json({ success: false, message: 'LinkedIn profile must be string or null' });
      return;
    }
    updateData.linkedInProfile = linkedInProfile || null;
  }

  if (skills !== undefined) {
    if (!Array.isArray(skills)) {
      res.status(400).json({ success: false, message: 'Skills must be an array' });
      return;
    }
    if (skills.some((s: any) => typeof s !== 'string')) {
      res.status(400).json({ success: false, message: 'All skills must be strings' });
      return;
    }
    updateData.skills = skills;
  }

  // Admin-only fields
  if (status !== undefined) {
    if (!['PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED'].includes(status?.toUpperCase())) {
      res.status(400).json({ success: false, message: 'Invalid status. Must be one of: PENDING, ACTIVE, SUSPENDED, DELETED' });
      return;
    }
    updateData.status = status?.toUpperCase();
  }

  if (role !== undefined) {
    // Only super admins can change roles
    if (!isSuperAdmin) {
      res.status(403).json({ success: false, message: 'Only super admins can change user roles' });
      return;
    }
    if (!['USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(role?.toUpperCase())) {
      res.status(400).json({ success: false, message: 'Invalid role. Must be one of: USER, MODERATOR, ADMIN, SUPER_ADMIN' });
      return;
    }
    updateData.role = role?.toUpperCase();
  }

  if (isVerified !== undefined) {
    if (typeof isVerified !== 'boolean') {
      res.status(400).json({ success: false, message: 'isVerified must be boolean' });
      return;
    }
    updateData.isVerified = isVerified;
  }

  if (hasPremiumBadge !== undefined) {
    if (typeof hasPremiumBadge !== 'boolean') {
      res.status(400).json({ success: false, message: 'hasPremiumBadge must be boolean' });
      return;
    }
    updateData.hasPremiumBadge = hasPremiumBadge;
  }

  if (Object.keys(updateData).length === 0) {
    res.status(400).json({ success: false, message: 'No fields to update' });
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: updateData,
    select: adminUserSelect
  });

  res.status(200).json({ success: true, data: serializeUser(user) });
});

export const updateUserProfile = updateProfile;

export const getAlumniDirectory = getPublicAlumni;

export const getUserSuggestions = getConnectionSuggestions;
