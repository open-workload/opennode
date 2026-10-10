import { Router, type IRouter } from "express";
import runsRouter from "./runs";
import membershipRouter from "./membership";
import flagsRouter from "./flags";
import clusterRouter from "./cluster";

const router: IRouter = Router();

router.use(runsRouter);
router.use(membershipRouter);
router.use(flagsRouter);
router.use(clusterRouter);

export default router;
