import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { createNotification } from '../utils/notifications';

interface AuthRequest extends Request {
  user?: {
    id: string;
    _id: string;
    role: string;
  };
}

const includeAuthor = {
  author: {
    select: {
      id: true,
      name: true,
      profileImage: true,
      role: true
    }
  }
};

export const createComment = async (req: AuthRequest, res: Response) => {
  try {
    const postId = String(req.params.postId || '');
    const { content, parentCommentId } = req.body;
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    let parentCommentAuthorId: string | null = null;
    if (parentCommentId) {
      const parentComment = await prisma.comment.findUnique({
        where: { id: String(parentCommentId) },
        select: { id: true, authorId: true, postId: true }
      });

      if (!parentComment || parentComment.postId !== postId) {
        return res.status(404).json({ success: false, message: 'Parent comment not found' });
      }

      parentCommentAuthorId = parentComment.authorId;
    }

    const actor = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true }
    });

    const created = await prisma.comment.create({
      data: {
        content,
        authorId: userId,
        postId,
        parentCommentId: parentCommentId || null
      },
      include: includeAuthor
    });

    await prisma.post.update({
      where: { id: postId },
      data: { commentCount: { increment: 1 } }
    });

    const actorName = actor?.name || 'Someone';
    const recipients = new Set<string>();

    if (post.authorId && post.authorId !== userId) {
      recipients.add(post.authorId);
    }

    if (parentCommentAuthorId && parentCommentAuthorId !== userId) {
      recipients.add(parentCommentAuthorId);
    }

    await Promise.all(
      [...recipients].map((recipientId) => {
        const isReplyTarget = parentCommentAuthorId === recipientId;
        return createNotification({
          userId: recipientId,
          title: isReplyTarget ? 'New reply to your comment' : 'New comment on your post',
          message: isReplyTarget
            ? `${actorName} replied to your comment.`
            : `${actorName} commented on your post.`,
          type: 'post',
          actionUrl: `/posts/${postId}`,
          metadata: {
            postId,
            commentId: created.id,
            parentCommentId: parentCommentId || null,
            actorId: userId,
            event: isReplyTarget ? 'comment_reply' : 'post_comment'
          }
        });
      })
    );

    return res.status(201).json({
      success: true,
      message: 'Comment added successfully',
      data: created
    });
  } catch (error: unknown) {
    console.error('Error creating comment:', error);
    return res.status(500).json({ success: false, message: 'Failed to create comment' });
  }
};

export const getPostComments = async (req: Request, res: Response) => {
  try {
    const postId = String(req.params.postId || '');
    const page = Number.parseInt(req.query.page as string, 10) || 1;
    const limit = Number.parseInt(req.query.limit as string, 10) || 20;
    const skip = (page - 1) * limit;

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: { postId, parentCommentId: null },
        include: includeAuthor,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.comment.count({ where: { postId, parentCommentId: null } })
    ]);

    return res.status(200).json({
      success: true,
      data: comments,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error: unknown) {
    console.error('Error fetching comments:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch comments' });
  }
};

export const getCommentReplies = async (req: Request, res: Response) => {
  try {
    const commentId = String(req.params.commentId || '');
    const page = Number.parseInt(req.query.page as string, 10) || 1;
    const limit = Number.parseInt(req.query.limit as string, 10) || 20;
    const skip = (page - 1) * limit;

    const parent = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!parent) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    const [replies, total] = await Promise.all([
      prisma.comment.findMany({
        where: { parentCommentId: commentId },
        include: includeAuthor,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.comment.count({ where: { parentCommentId: commentId } })
    ]);

    return res.status(200).json({
      success: true,
      data: replies,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error: unknown) {
    console.error('Error fetching replies:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch replies' });
  }
};

export const likeComment = async (req: AuthRequest, res: Response) => {
  try {
    const commentId = String(req.params.commentId || '');
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: { likes: { select: { id: true } } }
    }) as (({ likes: Array<{ id: string }> } & Record<string, unknown>) | null);

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    if (comment.likes?.some((likeUser) => likeUser.id === userId)) {
      return res.status(400).json({ success: false, message: 'You have already liked this comment' });
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { likes: { connect: { id: userId } } },
      include: { likes: { select: { id: true } } }
    }) as { likes: Array<{ id: string }> };

    if (comment.authorId !== userId) {
      const actor = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true }
      });

      await createNotification({
        userId: comment.authorId,
        title: 'Your comment got a like',
        message: `${actor?.name || 'Someone'} liked your comment.`,
        type: 'post',
        actionUrl: `/posts/${comment.postId}`,
        metadata: {
          postId: comment.postId,
          commentId,
          actorId: userId,
          event: 'comment_like'
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Comment liked successfully',
      data: { likeCount: updated.likes.length }
    });
  } catch (error: unknown) {
    console.error('Error liking comment:', error);
    return res.status(500).json({ success: false, message: 'Failed to like comment' });
  }
};

export const unlikeComment = async (req: AuthRequest, res: Response) => {
  try {
    const commentId = String(req.params.commentId || '');
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: { likes: { select: { id: true } } }
    }) as (({ likes: Array<{ id: string }> } & Record<string, unknown>) | null);

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    if (!comment.likes?.some((likeUser) => likeUser.id === userId)) {
      return res.status(400).json({ success: false, message: 'You have not liked this comment' });
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { likes: { disconnect: { id: userId } } },
      include: { likes: { select: { id: true } } }
    }) as { likes: Array<{ id: string }> };

    return res.status(200).json({
      success: true,
      message: 'Comment unliked successfully',
      data: { likeCount: updated.likes.length }
    });
  } catch (error: unknown) {
    console.error('Error unliking comment:', error);
    return res.status(500).json({ success: false, message: 'Failed to unlike comment' });
  }
};

export const deleteComment = async (req: AuthRequest, res: Response) => {
  try {
    const commentId = String(req.params.commentId || '');
    const userId = req.user?.id || req.user?._id;
    const userRole = (req.user?.role || '').toLowerCase();

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    const isAuthor = comment.authorId === userId;
    const isAdmin = userRole === 'admin' || userRole === 'super_admin';

    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ success: false, message: 'You are not authorized to delete this comment' });
    }

    const repliesCount = await prisma.comment.count({ where: { parentCommentId: commentId } });

    await prisma.comment.deleteMany({ where: { OR: [{ id: commentId }, { parentCommentId: commentId }] } });

    await prisma.post.update({
      where: { id: comment.postId },
      data: { commentCount: { decrement: repliesCount + 1 } }
    });

    return res.status(200).json({ success: true, message: 'Comment deleted successfully' });
  } catch (error: unknown) {
    console.error('Error deleting comment:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete comment' });
  }
};
