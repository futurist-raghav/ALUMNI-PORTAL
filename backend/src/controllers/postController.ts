import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { asyncHandler } from '../middleware/errorHandler';
import { createNotification } from '../utils/notifications';

interface AuthRequest extends Request {
  user?: any;
}

interface LinkedInImportPostInput {
  title?: string;
  content?: string;
  postUrl?: string;
  publishedAt?: string;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

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

const isAdminRole = (role: unknown) => {
  const normalized = typeof role === 'string' ? role.toLowerCase() : '';
  return normalized === 'admin' || normalized === 'super_admin' || normalized === 'moderator';
};

const postSelect = {
  id: true,
  title: true,
  content: true,
  authorId: true,
  category: true,
  isFeatured: true,
  isSchoolUpdate: true,
  visibility: true,
  tags: true,
  attachments: true,
  externalLinks: true,
  sharedPostId: true,
  shareType: true,
  shareCount: true,
  createdAt: true,
  updatedAt: true,
  author: {
    select: {
      id: true,
      name: true,
      profileImage: true,
      role: true,
      admissionYear: true
    }
  },
  _count: {
    select: {
      comments: true,
      bookmarks: true,
      reactions: {
        where: {
          type: 'like'
        }
      }
    }
  }
} as const;

const normalizePost = (
  post: any,
  viewerState: {
    isLiked?: boolean;
    isBookmarked?: boolean;
  } = {}
) => ({
  ...post,
  author: {
    ...post.author,
    role: typeof post.author?.role === 'string' ? post.author.role.toLowerCase() : post.author?.role,
    classYear: post.author?.admissionYear ? Number.parseInt(post.author.admissionYear, 10) : undefined
  },
  reactions: [],
  bookmarks: [],
  reactionCount: post._count?.reactions ?? 0,
  bookmarkCount: post._count?.bookmarks ?? 0,
  commentCount: post._count?.comments ?? 0,
  shareCount: post.shareCount ?? 0,
  isLiked: Boolean(viewerState.isLiked),
  isBookmarked: Boolean(viewerState.isBookmarked)
});

const enrichPostsWithViewerState = async (
  posts: any[],
  currentUserId?: string,
  options: { allAreBookmarked?: boolean } = {}
) => {
  if (!Array.isArray(posts) || posts.length === 0) {
    return [];
  }

  if (!currentUserId) {
    return posts.map((post) => normalizePost(post));
  }

  const postIds = posts.map((post) => post.id);

  const [likes, bookmarks] = await Promise.all([
    prisma.postReaction.findMany({
      where: {
        postId: { in: postIds },
        userId: currentUserId,
        type: 'like'
      },
      select: {
        postId: true
      }
    }),
    options.allAreBookmarked
      ? Promise.resolve(postIds.map((id) => ({ id })))
      : prisma.post.findMany({
          where: {
            id: { in: postIds },
            bookmarks: {
              some: { id: currentUserId }
            }
          },
          select: {
            id: true
          }
        })
  ]);

  const likedPostIds = new Set(likes.map((item) => item.postId));
  const bookmarkedPostIds = new Set(bookmarks.map((item) => item.id));

  return posts.map((post) =>
    normalizePost(post, {
      isLiked: likedPostIds.has(post.id),
      isBookmarked: bookmarkedPostIds.has(post.id)
    })
  );
};

export const createPost = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { content, title, category, visibility, tags, attachments, externalLinks, originalPostId, shareType } = req.body;
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!content && !attachments && !originalPostId) {
    res.status(400).json({ success: false, message: 'Content, attachments, or shared post is required' });
    return;
  }

  const newPost = await prisma.post.create({
    data: {
      content,
      title: title || null,
      category: category || 'general',
      visibility: visibility || 'public',
      tags: tags || [],
      attachments: attachments || null,
      externalLinks: externalLinks || [],
      authorId: req.user.id,
      sharedPostId: originalPostId || null,
      shareType: shareType || null
    },
    select: postSelect
  });

  const normalizedPost = normalizePost(newPost, { isLiked: false, isBookmarked: false });
  res.status(201).json({ success: true, data: normalizedPost, post: normalizedPost });
});

export const getAllPosts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);

  const { category, search, tags, authorId, visibility } = req.query;

  const where: any = {};
  if (category) where.category = category as string;
  if (authorId) where.authorId = authorId as string;
  if (visibility) where.visibility = visibility as string;
  if (search) where.content = { contains: search as string, mode: 'insensitive' };
  if (tags) {
    const tagsArray = (tags as string).split(',').map(t => t.trim());
    where.tags = { hasSome: tagsArray };
  }

  const [posts, total] = await Promise.all([
    prisma.post.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
      select: postSelect
    }),
    prisma.post.count({ where })
  ]);

  const normalizedPosts = await enrichPostsWithViewerState(posts, req.user?.id);

  res.status(200).json({
    success: true,
    data: normalizedPosts,
    posts: normalizedPosts,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const getPostById = asyncHandler(async (req: Request, res: Response) => {
  const { postId } = req.params;
  if (!postId) {
    res.status(400).json({ success: false, message: 'Post ID is required' });
    return;
  }

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: postSelect
  });

  if (!post) {
    res.status(404).json({ success: false, message: 'Post not found' });
    return;
  }
  res.status(200).json({ success: true, data: normalizePost(post) });
});

export const updatePost = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { postId } = req.params;
  if (!postId) {
    res.status(400).json({ success: false, message: 'Post ID is required' });
    return;
  }
  
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) {
    res.status(404).json({ success: false, message: 'Post not found' });
    return;
  }

  if (post.authorId !== req.user.id && !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const { content, title, category, visibility, tags, attachments, externalLinks } = req.body;
  const updatedPost = await prisma.post.update({
    where: { id: postId },
    data: {
      content: content ?? post.content,
      title: title ?? post.title,
      category: category ?? post.category,
      visibility: visibility ?? post.visibility,
      tags: tags ?? post.tags,
      attachments: attachments ?? post.attachments,
      externalLinks: externalLinks ?? post.externalLinks
    },
    select: postSelect
  });

  const normalizedPost = normalizePost(updatedPost, { isLiked: false, isBookmarked: false });
  res.status(200).json({ success: true, data: normalizedPost, post: normalizedPost });
});

export const deletePost = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { postId } = req.params;
  if (!postId) {
    res.status(400).json({ success: false, message: 'Post ID is required' });
    return;
  }
  
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) {
    res.status(404).json({ success: false, message: 'Post not found' });
    return;
  }

  if (post.authorId !== req.user.id && !isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  await prisma.post.delete({ where: { id: postId } });
  res.status(200).json({ success: true, data: {} });
});

export const likePost = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { postId } = req.params;
  if (!postId) {
    res.status(400).json({ success: false, message: 'Post ID is required' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true }
  });

  if (!post) {
    res.status(404).json({ success: false, message: 'Post not found' });
    return;
  }

  const reactionType = req.body?.reactionType || 'like';

  const existingReaction = await prisma.postReaction.findUnique({
    where: { postId_userId: { postId, userId: req.user.id } }
  });

  let message = '';
  let shouldNotifyAuthor = false;
  let resultingReactionType: string | null = null;
  if (existingReaction) {
    if (existingReaction.type === reactionType) {
      await prisma.postReaction.delete({
        where: { postId_userId: { postId, userId: req.user.id } }
      });
      message = 'Post reaction removed';
    } else {
      await prisma.postReaction.update({
        where: { postId_userId: { postId, userId: req.user.id } },
        data: { type: reactionType }
      });
      message = 'Post reaction updated';
      shouldNotifyAuthor = true;
      resultingReactionType = reactionType;
    }
  } else {
    await prisma.postReaction.create({ data: { postId, userId: req.user.id, type: reactionType } });
    message = 'Post reacted';
    shouldNotifyAuthor = true;
    resultingReactionType = reactionType;
  }

  if (shouldNotifyAuthor && post.authorId !== req.user.id) {
    const actor = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { name: true }
    });

    await createNotification({
      userId: post.authorId,
      title: 'New reaction on your post',
      message: `${actor?.name || 'Someone'} reacted to your post.`,
      type: 'post',
      actionUrl: `/posts/${postId}`,
      metadata: {
        postId,
        actorId: req.user.id,
        reactionType,
        event: 'post_reaction'
      }
    });
  }

  const updatedPost = await prisma.post.findUnique({
    where: { id: postId },
    select: postSelect
  });

  const isBookmarked = await prisma.post.findFirst({
    where: {
      id: postId,
      bookmarks: {
        some: { id: req.user.id }
      }
    },
    select: { id: true }
  });

  const normalizedPost = updatedPost
    ? normalizePost(updatedPost, {
        isLiked: resultingReactionType === 'like',
        isBookmarked: Boolean(isBookmarked)
      })
    : undefined;

  res.status(200).json({ success: true, message, data: normalizedPost, post: normalizedPost });
});

export const bookmarkPost = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { postId } = req.params;
  if (!postId) {
    res.status(400).json({ success: false, message: 'Post ID is required' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true }
  });

  if (!post) {
    res.status(404).json({ success: false, message: 'Post not found' });
    return;
  }

  const existingBookmark = await prisma.post.findFirst({
    where: {
      id: postId,
      bookmarks: {
        some: { id: req.user.id }
      }
    },
    select: { id: true }
  });

  let message = '';
  if (existingBookmark) {
    await prisma.post.update({
      where: { id: postId },
      data: { bookmarks: { disconnect: { id: req.user.id } } }
    });
    message = 'Post removed from bookmarks';
  } else {
    await prisma.post.update({
      where: { id: postId },
      data: { bookmarks: { connect: { id: req.user.id } } }
    });
    message = 'Post bookmarked';
  }

  const postSnapshot = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      id: true,
      _count: {
        select: {
          bookmarks: true
        }
      }
    }
  });

  res.status(200).json({
    success: true,
    message,
    data: {
      postId,
      isBookmarked: !existingBookmark,
      bookmarkCount: postSnapshot?._count?.bookmarks ?? 0
    }
  });
});

export const sharePost = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { originalPostId, content, visibility, shareType } = req.body;
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!originalPostId) {
    res.status(400).json({ success: false, message: 'Original post ID is required' });
    return;
  }

  const originalPost = await prisma.post.findUnique({ where: { id: originalPostId } });
  if (!originalPost) {
    res.status(404).json({ success: false, message: 'Original post not found' });
    return;
  }

  const newPost = await prisma.post.create({
    data: {
      content: content || '',
      visibility: visibility || 'public',
      category: 'general',
      authorId: req.user.id,
      sharedPostId: originalPostId,
      shareType: shareType || 'simple'
    },
    select: postSelect
  });

  const normalizedPost = normalizePost(newPost, { isLiked: false, isBookmarked: false });
  await prisma.post.update({
    where: { id: originalPostId },
    data: { shareCount: { increment: 1 } }
  });

  res.status(201).json({ success: true, data: normalizedPost, post: normalizedPost });
});

export const importLinkedInPosts = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const linkedInProfile = typeof req.body?.linkedInProfile === 'string' ? req.body.linkedInProfile.trim() : '';
  const incomingPosts: LinkedInImportPostInput[] = Array.isArray(req.body?.posts) ? req.body.posts : [];

  if (incomingPosts.length === 0) {
    res.status(400).json({ success: false, message: 'At least one LinkedIn post is required' });
    return;
  }

  const createdPosts: any[] = [];
  let skipped = 0;

  for (const rawPost of incomingPosts.slice(0, 50)) {
    const content = typeof rawPost?.content === 'string' ? rawPost.content.trim() : '';
    if (!content) {
      skipped += 1;
      continue;
    }

    const postUrl = typeof rawPost?.postUrl === 'string' ? rawPost.postUrl.trim() : '';
    const normalizedTitle = typeof rawPost?.title === 'string' ? rawPost.title.trim() : '';
    const publishedAt = typeof rawPost?.publishedAt === 'string' ? rawPost.publishedAt : undefined;
    const parsedPublishedDate = publishedAt ? new Date(publishedAt) : undefined;
    const hasValidPublishedDate = parsedPublishedDate && !Number.isNaN(parsedPublishedDate.getTime());

    const duplicatePost = await prisma.post.findFirst({
      where: {
        authorId: req.user.id,
        content,
        tags: { has: 'linkedin-import' },
        ...(postUrl ? { externalLinks: { has: postUrl } } : {})
      },
      select: { id: true }
    });

    if (duplicatePost) {
      skipped += 1;
      continue;
    }

    const createdPost = await prisma.post.create({
      data: {
        authorId: req.user.id,
        title: normalizedTitle || null,
        content,
        category: 'networking',
        visibility: 'public',
        tags: ['linkedin-import'],
        externalLinks: [
          ...new Set([postUrl, linkedInProfile].filter(Boolean))
        ],
        ...(hasValidPublishedDate ? { createdAt: parsedPublishedDate } : {})
      },
      select: postSelect
    });

    createdPosts.push(normalizePost(createdPost, { isLiked: false, isBookmarked: false }));
  }

  res.status(201).json({
    success: true,
    data: createdPosts,
    importedCount: createdPosts.length,
    skippedCount: skipped,
    message: `Imported ${createdPosts.length} LinkedIn post${createdPosts.length === 1 ? '' : 's'}`
  });
});

export const getFeedPosts = asyncHandler(async (req: AuthRequest, res: Response) => {
  // Simple fallback feed, returning recent posts
  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);

  const [posts, total] = await Promise.all([
    prisma.post.findMany({
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
      select: postSelect
    }),
    prisma.post.count()
  ]);

  const normalizedPosts = await enrichPostsWithViewerState(posts, req.user?.id);

  res.status(200).json({
    success: true,
    data: normalizedPosts,
    posts: normalizedPosts,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const getBookmarkedPosts = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);

  const posts = await prisma.post.findMany({
    where: {
      bookmarks: {
        some: { id: req.user.id }
      }
    },
    select: postSelect,
    orderBy: { createdAt: 'desc' },
    skip, take: limit
  });

  const total = await prisma.post.count({
    where: {
      bookmarks: {
        some: { id: req.user.id }
      }
    }
  });

  const normalizedPosts = await enrichPostsWithViewerState(posts, req.user.id, { allAreBookmarked: true });

  res.status(200).json({
    success: true,
    data: normalizedPosts,
    posts: normalizedPosts,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

export const getFeaturedPosts = asyncHandler(async (req: Request, res: Response) => {
  const requestedLimit = parsePositiveInt(req.query.limit, 10);
  const limit = Math.min(requestedLimit, 25);

  const posts = await prisma.post.findMany({
    where: { isFeatured: true },
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: postSelect
  });

  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.status(200).json({ success: true, data: posts.map((post) => normalizePost(post)) });
});

export const getSchoolUpdates = asyncHandler(async (req: Request, res: Response) => {
  const requestedLimit = parsePositiveInt(req.query.limit, 20);
  const limit = Math.min(requestedLimit, 40);

  const posts = await prisma.post.findMany({
    where: { isSchoolUpdate: true },
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: postSelect
  });

  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.status(200).json({ success: true, data: posts.map((post) => normalizePost(post)) });
});

export const toggleFeaturePost = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!isAdminRole(req.user.role)) {
    res.status(403).json({ success: false, message: 'Not authorized' });
    return;
  }

  const { postId } = req.params;
  if (!postId) {
    res.status(400).json({ success: false, message: 'Post ID is required' });
    return;
  }

  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) {
    res.status(404).json({ success: false, message: 'Post not found' });
    return;
  }

  const updatedPost = await prisma.post.update({
    where: { id: postId },
    data: { isFeatured: !post.isFeatured },
    select: postSelect
  });

  res.status(200).json({ success: true, data: normalizePost(updatedPost) });
});
