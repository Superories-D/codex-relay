import { expect,it } from "vitest";
import { fitWindow } from "../src/main/window-placement";
it("recovers a disconnected monitor and clamps oversized windows",()=>{
  expect(fitWindow({x:3000,y:-900,width:2000,height:1200,maximized:true},[{x:0,y:0,width:1024,height:768}])).toEqual({x:0,y:0,width:1024,height:768,maximized:true});
});
it("keeps negative-coordinate monitors and rejects corrupt geometry",()=>{
  const displays=[{x:0,y:0,width:1920,height:1080},{x:-1280,y:0,width:1280,height:800}];
  expect(fitWindow({x:-1200,y:20,width:900,height:600},displays).x).toBe(-1200);
  expect(fitWindow({x:Infinity},displays).width).toBe(1280);
});
