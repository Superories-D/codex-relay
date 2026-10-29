import {expect,it} from "vitest";
import {searchContext,searchPageValue,textMatches} from "../src/renderer/conversation-search";
it("matches literal punctuation and HTML without regex interpretation",()=>{
 expect(textMatches("<script>[a+b] [a+b]</script>","[a+b]").matches).toEqual([{start:8,end:13},{start:14,end:19}]);
 expect(textMatches(".* .x", ".*").matches).toEqual([{start:0,end:2}]);
});
it("maps normalized full-width, ligature and combining matches to original source bytes",()=>{
 for(const [text,query,expected] of [["ＡＢＣ","abc",{start:0,end:3}],["ﬁle","file",{start:0,end:3}],["e\u0301","é",{start:0,end:2}],["İstanbul","i\u0307s",{start:0,end:2}]] as const){
  expect(textMatches(text,query).matches).toEqual([expected]);
 }
 expect(textMatches("ﬀ", "f").matches).toEqual([{start:0,end:1}]);
 expect(textMatches("😀needle😀NEEDLE","needle").matches).toEqual([{start:2,end:8},{start:10,end:16}]);
});
it("bounds highlight work without truncating source and rejects empty queries",()=>{
 expect(textMatches("aaaa", "a", 2)).toEqual({matches:[{start:0,end:1},{start:1,end:2}],limited:true});
 expect(textMatches("aaaa", "a", 4).limited).toBe(false);
 expect(textMatches("text", " ").matches).toEqual([]);
});
it("keeps returned page cursors only when they advance and scopes results to role/query/conversation",()=>{
 expect(searchPageValue({items:[],total:90,next:7},30).next).toBeUndefined();
 expect(searchPageValue({items:[],total:90,next:45},30).next).toBe(45);
 expect(searchContext("a","q","tool",0)).not.toBe(searchContext("a","q","user",0));
 expect(searchContext("a","q","tool",0)).not.toBe(searchContext("b","q","tool",0));
});
