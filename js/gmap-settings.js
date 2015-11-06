// ==========  START GOOGLE MAP ========== //
function initialize() {
"use strict";
var myLatLng = new google.maps.LatLng(23.73176,90.40640);
var roadAtlasStyles = [{"stylers":[{"hue":"#ff1a00"},{"invert_lightness":true},{"saturation":-100},{"lightness":33},{"gamma":0.5}]},{"featureType":"water","elementType":"geometry","stylers":[{"color":"#2D333C"}]}];

var mapOptions = {
    zoom: 14,
    center: myLatLng,
  	disableDefaultUI: true,
	  scrollwheel: false,
    navigationControl: false,
    mapTypeControl: false,
    scaleControl: false,
    draggable: false,
    mapTypeControlOptions: {
    mapTypeIds: [google.maps.MapTypeId.ROADMAP, 'roadatlas']
    }
  };

  var map = new google.maps.Map(document.getElementById('map_canvas'), mapOptions);
  var e = map.getCenter();                 
   
  var marker = new google.maps.Marker({
      position: myLatLng,
      map: map,
      icon: 'img/location-icon.png',
	  title: '',
  });
  
  var contentString = '<div style="max-width: 300px" id="content">'+
      '<div id="bodyContent">'+
	  '<h4>John Doe</h4>' +
      '<p style="font-size: 12px">12, Segun Bagicha, 10th floor,<br>Dhaka, Bangladesh.</p>'+
      '</div>'+
      '</div>';

  var infowindow = new google.maps.InfoWindow({
      content: contentString
  });
  
  google.maps.event.addListener(marker, 'click', function() {
    infowindow.open(map,marker);
  });
  $(".button-map").click(function () {
        $("#map_canvas").slideToggle(300, function () {
            google.maps.event.trigger(map, "resize"), map.setCenter(e)
        }), $(this).toggleClass("close-map show-map")
  })
  var styledMapOptions = {
    name: 'US Road Atlas'
  };

  var usRoadMapType = new google.maps.StyledMapType(
      roadAtlasStyles, styledMapOptions);

  map.mapTypes.set('roadatlas', usRoadMapType);
  map.setMapTypeId('roadatlas');
}

if($('#map_canvas').length)
google.maps.event.addDomListener(window, "load", initialize);
// ========== END GOOGLE MAP ========== //