import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketsRouter from "./markets";
import eventsRouter from "./events";
import summaryRouter from "./summary";
import pricesRouter from "./prices";
import tradeRouter from "./trade";
import streamRouter from "./stream";
import analyticsRouter from "./analytics";
import publicSnapshotRouter from "./publicSnapshot";
import restingOrderSimRouter from "./restingOrderSim";
import reportRouter from "./report";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketsRouter);
router.use(eventsRouter);
router.use(summaryRouter);
router.use(pricesRouter);
router.use(tradeRouter);
router.use(streamRouter);
router.use(analyticsRouter);
router.use(publicSnapshotRouter);
router.use(restingOrderSimRouter);
router.use(reportRouter);

export default router;
