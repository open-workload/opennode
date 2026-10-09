import { Router, type IRouter } from "express";
import runsRouter from "./runs";
import membershipRouter from "./membership";
import flagsRouter from "./flags";

const router: IRouter = Router();

router.use(runsRouter);
router.use(membershipRouter);
router.use(flagsRouter);

export default router;
