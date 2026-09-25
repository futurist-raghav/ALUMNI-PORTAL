# Sentinel Security Journal

## 2026-03-28 - Mass Assignment Prevention in Profile Updates
**Vulnerability:** Unfiltered spread operator (`...req.body`) in `updateProfile` allowed users to overwrite restricted user model fields (e.g. `role`, `status`, `isVerified`).
**Learning:** Spread operators on raw request bodies in ORM update calls expose all model properties to client mass assignment attacks.
**Prevention:** Always filter user input through an explicit whitelist constant before passing objects to database updates.
