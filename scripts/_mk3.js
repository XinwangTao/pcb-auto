const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const u=await eda.dmt_Project.createProject("AI_NF2",null,null,null,"nf2");
await eda.dmt_Project.openProject(u); await sleep(2000);
await eda.dmt_Project.waitForReady(u,60000);
await eda.dmt_Board.createBoard(); await sleep(2500);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
return {projectUuid:u, pageUuid:b.schematic.page[0].uuid};
