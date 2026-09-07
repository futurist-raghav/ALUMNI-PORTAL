import { Request, Response } from 'express';
import { Role } from '@prisma/client';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/errorHandler';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: string;
    email: string;
    name?: string;
  };
}

const isAdminRole = (role?: string) => {
  const normalized = (role || '').toLowerCase();
  return normalized === 'moderator' || normalized === 'admin' || normalized === 'super_admin' || String(role) === 'MODERATOR' || role === Role.ADMIN || role === Role.SUPER_ADMIN;
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const SORTABLE_JOB_FIELDS = new Set(['createdAt', 'applicationDeadline', 'applicationCount', 'title', 'company']);

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

const jobInclude = {
  postedBy: {
    select: {
      id: true,
      name: true,
      profileImage: true
    }
  }
} as const;

const formatJob = (job: any) => ({
  ...job,
  salaryRange:
    job.salaryRangeMin !== null && job.salaryRangeMin !== undefined &&
    job.salaryRangeMax !== null && job.salaryRangeMax !== undefined
      ? {
          min: job.salaryRangeMin,
          max: job.salaryRangeMax,
          currency: job.salaryCurrency || 'USD'
        }
      : undefined,
  postedDate: job.createdAt,
  applicants: []
});

const safeTrim = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const isValidResumeUrl = (value: string): boolean => {
  if (value.startsWith('/api/uploads/')) {
    return true;
  }

  return isHttpUrl(value);
};

const readMetadataString = (metadata: Record<string, unknown>, key: string): string | undefined => {
  const value = metadata[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const getJobs = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);

  const {
    type,
    location,
    company,
    isActive = 'true',
    postedBy,
    tags,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  const where: any = {};
  
  if (isActive !== 'all') where.isActive = isActive === 'true';
  if (type) where.type = String(type);
  if (location) where.location = { contains: String(location), mode: 'insensitive' };
  if (company) where.company = { contains: String(company), mode: 'insensitive' };
  if (postedBy) where.postedById = String(postedBy);
  if (tags) {
    const tagArray = String(tags).split(',').map(tag => tag.trim());
    where.tags = { hasSome: tagArray };
  }

  const requestedSortBy = typeof sortBy === 'string' ? sortBy : 'createdAt';
  const resolvedSortBy = SORTABLE_JOB_FIELDS.has(requestedSortBy) ? requestedSortBy : 'createdAt';
  const resolvedSortOrder = sortOrder === 'asc' ? 'asc' : 'desc';

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: { [resolvedSortBy]: resolvedSortOrder },
      skip,
      take: limit,
      include: jobInclude
    }),
    prisma.job.count({ where })
  ]);

  const formattedJobs = jobs.map(formatJob);

  res.status(200).json({
    success: true,
    data: formattedJobs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const getJobById = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  const job = await prisma.job.findUnique({
    where: { id },
    include: jobInclude
  });

  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }
  res.status(200).json({ success: true, data: formatJob(job) });
});

export const createJob = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { title, company, location, type, salaryRange, description, requirements, benefits, applicationUrl, contactEmail, isAlumniReferral, applicationDeadline, tags } = req.body;

  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!title || !company || !location || !type || !description) {
    res.status(400).json({ success: false, message: 'Missing required fields' });
    return;
  }

  const postingUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { name: true }
  });

  const jobData: any = {
    title, company, location, type, description,
    requirements: requirements || [], benefits: benefits || [],
    postedById: req.user.id,
    postedByName: postingUser?.name || req.user.name || req.user.email,
    isAlumniReferral: isAlumniReferral ?? true,
    tags: tags || []
  };

  if (salaryRange?.min !== undefined && salaryRange?.max !== undefined) {
    jobData.salaryRangeMin = Number(salaryRange.min);
    jobData.salaryRangeMax = Number(salaryRange.max);
    jobData.salaryCurrency = salaryRange.currency || 'USD';
  }
  if (applicationUrl) jobData.applicationUrl = applicationUrl;
  if (contactEmail) jobData.contactEmail = contactEmail;
  if (applicationDeadline) jobData.applicationDeadline = new Date(applicationDeadline);

  const job = await prisma.job.create({
    data: jobData,
    include: jobInclude
  });

  res.status(201).json({ success: true, data: formatJob(job) });
});

export const updateJob = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  const updateData = { ...req.body };

  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }

  if (job.postedById !== req.user.id && !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const allowedUpdates = new Set([
    'title', 'company', 'location', 'type', 'salaryRange', 'description',
    'requirements', 'benefits', 'applicationUrl', 'contactEmail',
    'isActive', 'applicationDeadline', 'tags'
  ]);

  const dataToUpdate: any = {};
  for (const key of Object.keys(updateData)) {
    if (allowedUpdates.has(key)) {
      if (key === 'salaryRange' && updateData[key]) {
        dataToUpdate.salaryRangeMin = Number(updateData[key].min);
        dataToUpdate.salaryRangeMax = Number(updateData[key].max);
        dataToUpdate.salaryCurrency = updateData[key].currency || 'USD';
      } else if (key === 'applicationDeadline' && updateData[key]) {
        dataToUpdate.applicationDeadline = new Date(updateData[key]);
      } else {
        dataToUpdate[key] = updateData[key];
      }
    }
  }

  const updatedJob = await prisma.job.update({
    where: { id },
    data: dataToUpdate,
    include: jobInclude
  });

  res.status(200).json({ success: true, data: formatJob(updatedJob) });
});

export const deleteJob = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }
  if (job.postedById !== req.user.id && !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }
  await prisma.job.delete({ where: { id } });
  res.status(200).json({ success: true, data: {} });
});

export const saveJob = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }
  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }

  await prisma.job.update({
    where: { id },
    data: {
      savedBy: {
        connect: { id: req.user.id }
      }
    }
  });

  res.status(200).json({ success: true, message: 'Job saved' });
});

export const unsaveJob = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }

  await prisma.job.update({
    where: { id },
    data: {
      savedBy: {
        disconnect: { id: req.user.id }
      }
    }
  });

  res.status(200).json({ success: true, message: 'Job unsaved' });
});

export const getSavedJobs = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20);

  const jobs = await prisma.job.findMany({
    where: {
      savedBy: {
        some: {
          id: req.user.id
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit,
    include: jobInclude
  });

  const total = await prisma.job.count({
    where: {
      savedBy: {
        some: {
          id: req.user.id
        }
      }
    }
  });

  res.status(200).json({
    success: true,
    data: jobs.map(formatJob),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const getAppliedJobs = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20);

  const where = {
    userId: req.user.id,
    type: 'job_application_submitted'
  } as const;

  const [applicationNotifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        metadata: true,
        createdAt: true
      }
    }),
    prisma.notification.count({ where })
  ]);

  const jobIds = applicationNotifications
    .map((notification) => {
      const metadata = notification.metadata as { jobId?: string } | null;
      return metadata?.jobId;
    })
    .filter((jobId): jobId is string => Boolean(jobId));

  if (jobIds.length === 0) {
    res.status(200).json({
      success: true,
      data: [],
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
    return;
  }

  const uniqueJobIds = Array.from(new Set(jobIds));

  const jobs = await prisma.job.findMany({
    where: { id: { in: uniqueJobIds } },
    include: jobInclude
  });

  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const orderedJobs = uniqueJobIds
    .map((jobId) => jobsById.get(jobId))
    .filter((job): job is NonNullable<typeof job> => Boolean(job));

  res.status(200).json({
    success: true,
    data: orderedJobs.map(formatJob),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const toggleSaveJob = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }

  const savedJob = await prisma.job.findFirst({
    where: {
      id,
      savedBy: {
        some: {
          id: req.user.id
        }
      }
    },
    select: { id: true }
  });

  if (savedJob) {
    await prisma.job.update({
      where: { id },
      data: {
        savedBy: {
          disconnect: { id: req.user.id }
        }
      }
    });

    res.status(200).json({ success: true, message: 'Job unsaved', data: { saved: false } });
    return;
  }

  await prisma.job.update({
    where: { id },
    data: {
      savedBy: {
        connect: { id: req.user.id }
      }
    }
  });

  res.status(200).json({ success: true, message: 'Job saved', data: { saved: true } });
});

export const incrementApplicationCount = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  const rawBody = req.body || {};
  const coverLetter = safeTrim(rawBody.coverLetter);
  const resumeUrl = safeTrim(rawBody.resumeUrl);
  const resumeFilename = safeTrim(rawBody.resumeFilename);
  const portfolioUrl = safeTrim(rawBody.portfolioUrl);

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }

  if (job.postedById === req.user.id) {
    res.status(400).json({ success: false, message: 'You cannot apply to your own job posting' });
    return;
  }

  if (coverLetter && coverLetter.length > 4000) {
    res.status(400).json({ success: false, message: 'Cover letter must be 4000 characters or fewer' });
    return;
  }

  if (portfolioUrl && !isHttpUrl(portfolioUrl)) {
    res.status(400).json({ success: false, message: 'Portfolio URL must be a valid http(s) URL' });
    return;
  }

  if (resumeUrl && !isValidResumeUrl(resumeUrl)) {
    res.status(400).json({ success: false, message: 'Resume URL is invalid' });
    return;
  }

  if (resumeFilename && !resumeUrl) {
    res.status(400).json({ success: false, message: 'Resume filename requires a resume URL' });
    return;
  }

  const existingApplication = await prisma.notification.findFirst({
    where: {
      userId: req.user.id,
      type: 'job_application_submitted',
      metadata: {
        path: ['jobId'],
        equals: id
      }
    },
    select: { id: true }
  });

  if (existingApplication) {
    res.status(200).json({
      success: true,
      message: 'You have already applied to this job',
      data: {
        alreadyApplied: true,
        applicationCount: job.applicationCount
      }
    });
    return;
  }

  const appliedAt = new Date().toISOString();

  const applicantMetadata = {
    jobId: job.id,
    jobTitle: job.title,
    company: job.company,
    coverLetter,
    resumeUrl,
    resumeFilename,
    portfolioUrl,
    appliedAt
  };

  const [updated] = await prisma.$transaction([
    prisma.job.update({
      where: { id },
      data: {
        applicationCount: {
          increment: 1
        }
      }
    }),
    prisma.notification.create({
      data: {
        userId: req.user.id,
        title: `Application submitted: ${job.title}`,
        message: `You successfully applied to ${job.title} at ${job.company}.`,
        type: 'job_application_submitted',
        actionUrl: `/jobs`,
        metadata: applicantMetadata
      }
    })
  ]);

  if (job.postedById !== req.user.id) {
    await prisma.notification.create({
      data: {
        userId: job.postedById,
        title: `New applicant for ${job.title}`,
        message: `${req.user.name || req.user.email} applied for your job posting.`,
        type: 'job_application_received',
        actionUrl: `/jobs`,
        metadata: {
          jobId: job.id,
          jobTitle: job.title,
          applicantId: req.user.id,
          applicantName: req.user.name || req.user.email,
          applicantEmail: req.user.email,
          coverLetter,
          resumeUrl,
          resumeFilename,
          portfolioUrl,
          appliedAt
        }
      }
    });
  }

  res.status(200).json({
    success: true,
    message: 'Application submitted successfully',
    data: {
      alreadyApplied: false,
      applicationCount: updated.applicationCount
    }
  });
});

export const getJobApplications = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = String(req.params.id || '');
  if (!id) {
    res.status(400).json({ success: false, message: 'Job ID is required' });
    return;
  }

  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      postedById: true
    }
  });

  if (!job) {
    res.status(404).json({ success: false, message: 'Job not found' });
    return;
  }

  if (job.postedById !== req.user.id && !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized to view job applications' });
    return;
  }

  const applicationNotifications = await prisma.notification.findMany({
    where: {
      userId: job.postedById,
      type: 'job_application_received',
      metadata: {
        path: ['jobId'],
        equals: id
      }
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      metadata: true
    }
  });

  const applications = applicationNotifications.map((notification) => {
    const metadata =
      notification.metadata && typeof notification.metadata === 'object' && !Array.isArray(notification.metadata)
        ? (notification.metadata as Record<string, unknown>)
        : {};

    return {
      id: notification.id,
      applicantId: readMetadataString(metadata, 'applicantId') || '',
      applicantName: readMetadataString(metadata, 'applicantName') || 'Unknown applicant',
      applicantEmail: readMetadataString(metadata, 'applicantEmail') || '',
      coverLetter: readMetadataString(metadata, 'coverLetter') || '',
      resumeUrl: readMetadataString(metadata, 'resumeUrl') || '',
      resumeFilename: readMetadataString(metadata, 'resumeFilename') || '',
      portfolioUrl: readMetadataString(metadata, 'portfolioUrl') || '',
      appliedAt: readMetadataString(metadata, 'appliedAt') || notification.createdAt.toISOString()
    };
  });

  res.status(200).json({
    success: true,
    data: applications,
    meta: {
      jobId: job.id,
      jobTitle: job.title,
      total: applications.length
    }
  });
});

export const searchJobs = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const rawQuery = req.query.query;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (!query) {
    res.status(200).json({ success: true, data: [] });
    return;
  }

  const jobs = await prisma.job.findMany({
    where: {
      isActive: true,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { company: { contains: query, mode: 'insensitive' } },
        { location: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } }
      ]
    },
    orderBy: { createdAt: 'desc' },
    include: jobInclude,
    take: 20
  });

  res.status(200).json({ success: true, data: jobs.map(formatJob) });
});

export const getJobStats = asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  const totalJobs = await prisma.job.count();
  const activeJobs = await prisma.job.count({ where: { isActive: true } });
  const applications = await prisma.job.aggregate({ _sum: { applicationCount: true } });

  res.status(200).json({
    success: true,
    data: {
      totalJobs,
      activeJobs,
      totalApplications: applications._sum.applicationCount || 0
    }
  });
});

