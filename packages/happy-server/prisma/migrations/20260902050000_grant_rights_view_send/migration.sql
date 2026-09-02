-- Grant rights are view and send (DROVE-388, decisions revision 3).
-- The first slice shipped them as read and answer; a right is what a
-- principal may do, and "send" says it without drover's gate vocabulary.
-- RENAME VALUE keeps every existing row; nothing is rewritten.
ALTER TYPE "SessionGrantRole" RENAME VALUE 'read' TO 'view';
ALTER TYPE "SessionGrantRole" RENAME VALUE 'answer' TO 'send';
