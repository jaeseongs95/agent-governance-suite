function proc(d){var r=[];for(var i=0;i<d.length;i++){if(d[i]!=null&&d[i]!=undefined){if(d[i].a==1){r.push(d[i].n.toUpperCase())}else{r.push(d[i].n)}}}return r}
function f2(x){return x.split(',').map(function(y){return y.trim()}).filter(function(z){return z!=''})}
module.exports={proc:proc,f2:f2}
