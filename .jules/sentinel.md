## 2026-10-11 - Mass Assignment Protection in Profile Update
**Vulnerability:** `updateProfile` in `backend/src/controllers/userController.ts` directly passed `data: { ...req.body }` to Prisma's `user.update()`, allowing non-administrative users to modify protected fields like `role`, `status`, `isVerified`, and `hasPremiumBadge`.
**Learning:** Object spread operators in Prisma update payloads bypass implicit field restrictions unless an explicit property whitelist is applied.
**Prevention:** Always filter input parameters against an explicit array of allowed properties (`allowedFields`) when performing update operations on entity models.
