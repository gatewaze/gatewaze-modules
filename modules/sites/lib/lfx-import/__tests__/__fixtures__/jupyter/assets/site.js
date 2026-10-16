(function(){"use strict";var d=document,h=d.documentElement;h.className=h.className.replace(/\bno-js\b/,"js");
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}
var t=d.querySelector(".menu-toggle");function setMenu(o){if(t)t.setAttribute("aria-expanded",o?"true":"false")}
if(t)t.addEventListener("click",function(){setMenu(t.getAttribute("aria-expanded")!=="true")});
var subs=[].slice.call(d.querySelectorAll(".sub-toggle"));function closeSubs(){subs.forEach(function(b){b.setAttribute("aria-expanded","false")})}
subs.forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var o=b.getAttribute("aria-expanded")!=="true";closeSubs();b.setAttribute("aria-expanded",o?"true":"false")})});
d.addEventListener("click",function(e){if(!e.target.closest||!e.target.closest(".has-sub"))closeSubs()});
d.addEventListener("focusin",function(e){subs.forEach(function(b){var li=b.parentNode;if(li&&!li.contains(e.target))b.setAttribute("aria-expanded","false")})});
d.addEventListener("keydown",function(e){if(e.key!=="Escape")return;var o=subs.filter(function(b){return b.getAttribute("aria-expanded")==="true"})[0];
if(o){closeSubs();o.focus()}else if(t&&t.getAttribute("aria-expanded")==="true"){setMenu(false);t.focus()}});
var c=d.getElementById("cookie");if(c){var k="lf-cookie-choice";if(!store(k))c.hidden=false;c.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-consent]");if(!b)return;
store(k,b.getAttribute("data-consent"));c.hidden=true;var m=d.getElementById("main");if(m){m.setAttribute("tabindex","-1");m.focus()}})}
[].forEach.call(d.querySelectorAll("form.lf-signup"),function(f){f.addEventListener("submit",function(e){var s=f.querySelector(".form-status");
if(!f.getAttribute("data-endpoint")){e.preventDefault();if(s)s.textContent="Sign-up isn't connected yet: wire this form to the LFX form endpoint before launch."}})});
d.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[data-page]");if(a&&window.parent!==window){e.preventDefault();window.parent.postMessage({lfxPage:a.getAttribute("data-page")},"*")}});
})();
