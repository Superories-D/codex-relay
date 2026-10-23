import {createRequire} from "node:module";
import {it,expect} from "vitest";
const {tunnelArguments}=createRequire(import.meta.url)("../scripts/remote-tunnel.cjs");
it("builds shell-free loopback-only tunnels with host verification",()=>{
 const result=tunnelArguments({host:"user@server.example","local-port":"9000"});
 expect(result.args).toContain("StrictHostKeyChecking=yes");expect(result.args).toContain("127.0.0.1:9000:127.0.0.1:7899");expect(result.args.slice(-2)).toEqual(["--","user@server.example"]);
 for(const host of ["-oProxyCommand=evil","user@host;touch file","https://host","host\nother"]){expect(()=>tunnelArguments({host})).toThrow();}
 for(const port of ["0","65536","1.5",""]){expect(()=>tunnelArguments({host:"server","local-port":port})).toThrow();}
});
