import {it,expect,vi,afterEach} from "vitest";
import {createRequire} from "node:module";
import {promises as fs} from "node:fs";
import ts from "typescript";
const {waitForBrowser}=createRequire(import.meta.url)("../scripts/qa/browser-wait.cjs");
afterEach(()=>vi.useRealTimers());
it("polls again when an async predicate resolves false instead of accepting its Promise",async()=>{
  vi.useFakeTimers();const evaluate=vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true),predicate=async()=>false;
  const waiting=waitForBrowser({evaluate},predicate,{id:"original"},{interval:10,timeout:100});await vi.advanceTimersByTimeAsync(25);
  expect(await waiting).toBe(true);expect(evaluate).toHaveBeenCalledTimes(3);expect(evaluate).toHaveBeenCalledWith(predicate,{id:"original"});
});
it("propagates a browser failure without silently turning it into polling",async()=>{
  const failure=Error("Browser transport failed"),evaluate=vi.fn().mockRejectedValue(failure);await expect(waitForBrowser({evaluate},()=>false)).rejects.toBe(failure);expect(evaluate).toHaveBeenCalledTimes(1);
});
it.each([false,true])("times out both repeated false and hung browser evaluations (hung=%s)",async hung=>{
  vi.useFakeTimers();const evaluate=vi.fn(()=>hung?new Promise(()=>{}):Promise.resolve(false)),waiting=waitForBrowser({evaluate},()=>false,undefined,{timeout:30,interval:10,message:"Expected delivery evidence"}),check=expect(waiting).rejects.toThrow("Expected delivery evidence");
  await vi.advanceTimersByTimeAsync(31);await check;expect(vi.getTimerCount()).toBe(0);
});
it("keeps asynchronous predicates out of Playwright's synchronous truthiness poller",async()=>{
  const invalid:string[]=[];
  for(const name of await fs.readdir("scripts/qa"))if(/\.(cjs|js|mjs)$/.test(name)) {
    const source=ts.createSourceFile(name,await fs.readFile("scripts/qa/"+name,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const visit=(node:ts.Node)=>{
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==="waitForFunction") {
        const predicate=node.arguments[0];
        if(predicate&&(ts.isArrowFunction(predicate)||ts.isFunctionExpression(predicate))&&predicate.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword))invalid.push(`${name}:${source.getLineAndCharacterOfPosition(node.pos).line+1}`);
      }
      ts.forEachChild(node,visit);
    };visit(source);
  }
  expect(invalid).toEqual([]);
});
