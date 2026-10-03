## 2026-10-03 - Mass Assignment Protection in User Profile Updates
**Vulnerability:** Mass Assignment (Over-posting) in `updateProfile` in `userController.ts` using object spread `{ ...req.body }`.
**Learning:** Passing `req.body` directly to Prisma `user.update` allows untrusted request bodies to inject privileged user attributes (such as `role` or `status`), escalating user permissions or altering sensitive fields.
**Prevention:** Always whitelist allowed user-editable fields when performing record updates in Prisma endpoints.
