//Skill Chart Data
var skillData = {
	skill1: [
		{
			title: "Adobe&nbsp;CS 90%",
			color: "#2C3E50",
			border: "4px solid #f4709f",
			value: '90%'
		},
		{
			title: "UI/UX Design 100%",
			color: "#2C3E50",
			border: "4px solid #f4709f",
			value: '100%'
		},
		{
			title: "Webtypography 80%",
			color: "#2C3E50",
			border: "4px solid #f4709f",
			value: '80%'
		},
		{
			title: "Logodesign 60%",
			color: "#2C3E50",
			border: "4px solid #f4709f",
			value: '60%'
		},
    {
			title: "3D Max 75%",
			color: "#2C3E50",
			border: "4px solid #f4709f",
			value: '75%'
		}
	],
	skill2: [
		{
			title: "HTML5/CSS3 90%",
			color: "#E74C3C",
			border: "4px solid #00CC66",
			value: '90%'
		},
		{
			title: "PHP 75%",
			color: "#E74C3C",
			border: "4px solid #00CC66",
			value: '75%'
		},
		{
			title: "MySQL 90%",
			color: "#E74C3C",
			border: "4px solid #00CC66",
			value: '90%'
		},
		{
			title: "JS/Jquery 60%",
			color: "#E74C3C",
			border: "4px solid #00CC66",
			value: '60%'
		},
    {
			title: "Wordpress 70%",
			color: "#E74C3C",
			border: "4px solid #00CC66",
			value: '70%'
		}
	],
}

//skillbar
function hasClass(e,t){return e.className.match(new RegExp("(\\s|^)"+t+"(\\s|$)"))}function addClass(e,t){if(!this.hasClass(e,t))e.className+=" "+t}function removeClass(e,t){if(hasClass(e,t)){var n=new RegExp("(\\s|^)"+t+"(\\s|$)");e.className=e.className.replace(n," ")}}function rotate(e){$("#l-inhalt").css("visibility","visible");document.getElementById("l-inhalt").setAttribute("class","show");if(document.querySelector(".btn-skills.active")!==null)removeClass(document.querySelector(".btn-skills.active"),"active");if(e==="rotate1"){addClass(document.querySelector(".skills-1"),"active");var t=skillData.skill1}if(e==="rotate2"){addClass(document.querySelector(".skills-2"),"active");var t=skillData.skill2}if(e==="rotate3"){addClass(document.querySelector(".skills-3"),"active");var t=skillData.skill3}updateBars(t)}function updateBars(data){clearBars();for(var i=0;i<data.length;i=i+1){var j=i+1;eval("document.getElementById('skill-bar"+j+"').style.height = data[i].value;");eval("document.getElementById('skill-bar"+j+"').style.backgroundColor = data[i].color;");eval("document.getElementById('skill-bar"+j+"').style.borderRight = data[i].border;");document.querySelector("#skill-bar"+j+" > .skill-caption").innerHTML=data[i].title}document.getElementById("l-inhalt").setAttribute("class","show")}function clearBars(){for(var i=0;i<5;i=i+1){var j=i+1;eval("document.getElementById('skill-bar"+j+"').style.height = '';");eval("document.getElementById('skill-bar"+j+"').style.backgroundColor = 'transparent';");eval("document.getElementById('skill-bar"+j+"').style.borderRight = 'none';");document.querySelector("#skill-bar"+j+" > .skill-caption").innerHTML=""}}