// Custom JavaScript
"use strict";

/***************************************************************
	SEARCH MOBILE DEVICE
***************************************************************/
var onMobile = false;
var isMobile = {
    Android: function() {
        return navigator.userAgent.match(/Android/i);
    },
    BlackBerry: function() {
        return navigator.userAgent.match(/BlackBerry/i);
    },
    iOS: function() {
        return navigator.userAgent.match(/iPhone|iPad|iPod/i);
    },
    Opera: function() {
        return navigator.userAgent.match(/Opera Mini/i);
    },
    Windows: function() {
        return navigator.userAgent.match(/IEMobile/i);
    },
    any: function() {
        return (isMobile.Android() || isMobile.BlackBerry() || isMobile.iOS() || isMobile.Opera() || isMobile.Windows());
    }
};
if (isMobile.any()) onMobile = true;

//Preloader
$(window).load(function() {
    $("#intro-loader").delay(600).fadeOut();
    $(".mask").delay(600).fadeOut("slow");
});

//Parallax
$(window).bind('load', function() {
    if (!onMobile)
        parallaxInit();
});

$(document).ready(function() {
    "use strict";
    //Elements Appear from top
    $('.item_top').each(function() {
        $(this).appear(function() {
            $(this).delay(200).animate({
                opacity: 1,
                top: "0px"
            }, 1000);
        });
    });

    //Elements Appear from bottom
    $('.item_bottom').each(function() {
        $(this).appear(function() {
            $(this).delay(200).animate({
                opacity: 1,
                bottom: "0px"
            }, 1000);
        });
    });
    //Elements Appear from left
    $('.item_left').each(function() {
        $(this).appear(function() {
            $(this).delay(200).animate({
                opacity: 1,
                left: "0px"
            }, 1000);
        });
    });

    //Elements Appear from left
    $('.item_left_fast').each(function() {
        $(this).appear(function() {
            $(this).delay(10).animate({
                opacity: 1,
                left: "0px"
            }, 50);
        });
    });

    //Elements Appear from right
    $('.item_right_fast').each(function() {
        $(this).appear(function() {
            $(this).delay(10).animate({
                opacity: 1,
                right: "0px"
            }, 50);
        });
    });

    //Elements Appear from right
    $('.item_right').each(function() {
        $(this).appear(function() {
            $(this).delay(200).animate({
                opacity: 1,
                right: "0px"
            }, 1000);
        });
    });

    //Elements Appear in fadeIn effect
    $('.item_fade_in').each(function() {
        $(this).appear(function() {
            $(this).delay(200).animate({
                opacity: 1,
                right: "0px"
            }, 1000);
        });
    });

    //Rev Slider
if($('.tp-banner').length){
    jQuery('.tp-banner').show().revolution({
        dottedOverlay: "none",
        delay: 8000,
        startwidth: 1170,
        startheight: 700,
        hideThumbs: 200,

        thumbWidth: 100,
        thumbHeight: 50,
        thumbAmount: 5,

        navigationType: "none",
        navigationArrows: "solo",
        navigationStyle: "preview4",

        touchenabled: "on",
        onHoverStop: "on",

        swipe_velocity: 0.7,
        swipe_min_touches: 1,
        swipe_max_touches: 1,
        drag_block_vertical: false,


        keyboardNavigation: "on",

        navigationHAlign: "center",
        navigationVAlign: "bottom",
        navigationHOffset: 0,
        navigationVOffset: 20,

        soloArrowLeftHalign: "left",
        soloArrowLeftValign: "center",
        soloArrowLeftHOffset: 20,
        soloArrowLeftVOffset: 0,

        soloArrowRightHalign: "right",
        soloArrowRightValign: "center",
        soloArrowRightHOffset: 20,
        soloArrowRightVOffset: 0,

        shadow: 0,
        fullWidth: "off",
        fullScreen: "on",

        spinner: "spinner0",

        stopLoop: "off",
        stopAfterLoops: -1,
        stopAtSlide: -1,

        shuffle: "off",

        forceFullWidth: "off",
        fullScreenAlignForce: "off",
        minFullScreenHeight: "400",

        hideThumbsOnMobile: "off",
        hideNavDelayOnMobile: 1500,
        hideBulletsOnMobile: "off",
        hideArrowsOnMobile: "off",
        hideThumbsUnderResolution: 0,

        hideSliderAtLimit: 0,
        hideCaptionAtLimit: 0,
        hideAllCaptionAtLilmit: 0,
        startWithSlide: 0,
        fullScreenOffsetContainer: ".header"
    });
  }

    if ($("#pie-container").length)
        rotate('rotate1');


    $('body').on('touchstart.dropdown', '.dropdown-menu', function(e) {
        e.stopPropagation();
    });
    //Back To Top
    $(window).scroll(function() {
        if ($(window).scrollTop() > 400) {
            $("#back-top").fadeIn(200);
        } else {
            $("#back-top").fadeOut(200);
        }
    });
    $('#back-top').click(function(event) {
        $('html, body').stop().animate({
            scrollTop: 0
        }, 1500, 'easeInOutExpo');
        event.preventDefault();
    });

    // PRETTYPHOTO //
    $("a[data-gal^='prettyPhoto']").prettyPhoto({
        animation_speed: "normal",
        theme: "light_rounded",
        opacity: 0.5,
        social_tools: false,
        deeplinking: false
    });

});

/*Navigation color change on scroll*/
$(window).load(function() {
  $('body').scrollspy({ 
		target: '.nav-menu',
		offset: 75
	})
});

// Append .background-image-holder <img>'s as CSS backgrounds
$('.bg-image-holder').each(function() {
    var imgSrc = $(this).children('img').attr('src');
    $(this).css('background', 'url("' + imgSrc + '") 50% 0%');
    $(this).children('.background-image').remove();
});

//Resume Timeline Event
if ($("ul.timeline").length) {
    $("ul.timeline .open").find(".content").slideDown();

 //  $("ul.timeline").on("click","li", function(){
	// 	var $this = $(this);
	// 	$this.find(".content").slideDown();
	// 	$this.addClass("open");
	// 	$this.siblings('li.open').find(".content").slideUp();
	// 	$this.siblings('li').removeClass("open");
	// }).on('mouseenter','li',function(){
	// 	var $this = $(this);
	// 	($this.hasClass('open'));
	// });
}

//Resume Timeline Event
if ($("ul.timeline_awards").length) {
    $("ul.timeline_awards .open").find(".content").slideDown();

  $("ul.timeline_awards").on("click","li", function(){
        var $this = $(this);
        $this.find(".content").slideDown();
        $this.addClass("open");
        $this.siblings('li.open').find(".content").slideUp();
        $this.siblings('li').removeClass("open");
    }).on('mouseenter','li',function(){
        var $this = $(this);
        ($this.hasClass('open'));
    });
}

// Share post  
$(function() {
    var url = window.location.href;
    var options = {
        twitter: true,
        facebook: true,
        googlePlus: true,
        pinterest: false,
        tumblr: false
    };

    $('.socialShare').shareButtons(url, options);

});

/* ==============================================
NAVIGATION DROP DOWN MENU
=============================================== */
$('.nav-toggle').hover(function() {
    $(this).find('.dropdown-menu').first().stop(true, true).fadeIn(450);
}, function() {
    $(this).find('.dropdown-menu').first().stop(true, true).fadeOut(450)
});
/* ==============================================
SOFT SCROLL EFFECT FOR NAVIGATION LINKS
=============================================== */
$('.scroll').bind('click', function(event) {
    var $anchor = $(this);
    var headerH = $('#navigation, #navigation-sticky').outerHeight();
    $('html, body').stop().animate({
        scrollTop: $($anchor.attr('href')).offset().top - headerH + "px"
    }, 1200, 'easeInOutExpo');
    event.preventDefault();
});
/* ==============================================
NAVIGATION SECTION CHANGEABLE BACKGROUND SCRIPT
=============================================== */
if($('.headerWrapper').length){
var menu = $('#navigation');
$(window).scroll(function() {
    var y = $(this).scrollTop();
    var homeH = $('.headerWrapper').outerHeight();
    var headerH = $('#navigation').outerHeight();
    var z = $('.headerWrapper').offset().top + homeH - headerH - 72;
    if (y >= z) {
        menu.removeClass('first-nav').addClass('second-nav');
    } else {
        menu.removeClass('second-nav').addClass('first-nav');
    }
});

var menu2 = $('#navigation-sticky');
$(window).scroll(function() {
    var y = $(this).scrollTop();
    var homeH = $('.headerWrapper').outerHeight();
    var headerH = $('#navigation-sticky').outerHeight();
    var z = $('.headerWrapper').offset().top + homeH - headerH - 72;
    if (y >= z) {
        menu2.removeClass('trans-nav').addClass('color-nav second-nav');
        if ($('.light-logo').length && $('.dark-logo').length) {
            $('.light-logo').css('display', 'none');
            $('.dark-logo').css('display', 'block');
        }
    } else {
        menu2.removeClass('color-nav second-nav').addClass('trans-nav');
        if ($('.light-logo').length && $('.dark-logo').length) {
            $('.dark-logo').css('display', 'none');
            $('.light-logo').css('display', 'block');
        }
    }
});
}
/* ==============================================
MOBILE NAV BUTTON
=============================================== */
$(".mobile-nav-button").click(function() {
    $(".nav-inner div.nav-menu").slideToggle("medium", function() {
        // Animation complete.
    });
});
$('.nav-inner div.nav-menu ul.nav li a').click(function() {
    if ($(window).width() < 1000) {
        $(".nav-menu").slideToggle("2000")
    }
});


function parallaxInit() {
    $('#testimonial').parallax("50%", 0.2);
    $('#quote').parallax("50%", 0.2);
}

    /*============================================
    	Owl - Carrousel
    	==============================================*/
    if (jQuery().owlCarousel) {
        if ($(".testimonial").length) {
            $(".testimonial").owlCarousel({
                navigation: false,
                pagination: true,
                responsive: true,
                //Basic Speeds
                slideSpeed: 600,
                paginationSpeed: 1000,
                transitionStyle: "fadeUp",
                items: 1,
                touchDrag: true,
                mouseDrag: true,
                autoHeight: false,
                autoPlay: 5000
            });
        }

        if ($("#client_carrousel").length) {
            $("#client_carrousel").owlCarousel({
                navigation: false,
                pagination: false,
                stopOnHover: true,
                itemsScaleUp: true,
                items: 5,
                responsive: {
                    0: {
                        items: 1
                    },
                    480: {
                        items: 2
                    },
                    768: {
                        items: 3
                    },
                    992: {
                        items: 4
                    },
                    1200: {
                        items: 5
                    }
                },
                autoPlay: 4000
            });
        }
        if ($(".gallery-slider").length) {
            $(".gallery-slider").owlCarousel({
                stopOnHover: true,
                navigation: true,
                navigationText: ["<i class='fa fa-long-arrow-left'></i>", "<i class='fa fa-long-arrow-right'></i>"],
                paginationSpeed: 3000,
                goToFirstSpeed: 2000,
                autoHeight: true,
                singleItem: true,
                transitionStyle: "fade"
            })
        }
    }
    /*-----------------------------------
    Flickr Feed
    -----------------------------------*/

    // Get your flickr ID from: http://idgettr.com/
    if ($('#flickr-feed').length) {
        var flickr_id = '60913863@N08'; // replace your flickr id here

        var $flcr_feed

        $flcr_feed = $('#flickr-feed');
        if ($flcr_feed.length) {
            $('#flickr-feed').jflickrfeed({
                limit: $flcr_feed.data('items'),
                qstrings: {
                    id: flickr_id
                },
                itemTemplate: '<li><a href="{{image_b}}" rel="prettyPhoto[flickr]"><img src="{{image_s}}" alt="{{title}}" /><span><i class="fa fa-search"></i></span></a></li>',
                itemCallback: function() {
                    $("a[rel='prettyPhoto[flickr]']").prettyPhoto({
                        animation_speed: "normal",
                        theme: "light_rounded",
                        opacity: 0.5,
                        social_tools: false,
                        deeplinking: false,
                        changepicturecallback: function() {
                            $('.pp_pic_holder').show();
                        }
                    });
                }
            });
        }
    }

$(window).load(function() {
    "use strict";
    // Contact Form Request
    if ($('#contactform').length) {
        $(".validate").validate();
        var form = $('#contactform');
        var submit = $('#contactForm_submit');
        var alertx = $('.form-respond');

        // form submit event
        $(document).on('submit', '#contactform', function(e) {
            e.preventDefault(); // prevent default form submit
            // sending ajax request through jQuery
            $.ajax({
                url: 'sendemail.php',
                type: 'POST',
                dataType: 'html',
                data: form.serialize(),
                beforeSend: function() {
                    alertx.fadeOut();
                    submit.html('Sending....'); // change submit button text
                },
                success: function(data) {
                    form.fadeOut(300);
                    alertx.html(data).fadeIn(1000); // fade in response data     
                    setTimeout(function() {
                        alertx.html(data).fadeOut(300);
                        $('#name, #email, #message').val('')
                        form.fadeIn(1800);
                    }, 4000);

                },
                error: function(e) {
                    console.log(e)
                }
            });
        });
    }

    //Leaving Page Fade Out
    $('a.external').click(function() {
        var url = $(this).attr('href');
        $('.mask').fadeIn(600, function() {
            document.location.href = url;
        });
        $("#intro-loader").fadeIn("slow");
        return false;
    });

    //Masonry Blog
    if ($('.blog-posts-content').length) {
        var $container = $('.blog-posts-content');
        $container.isotope({
            masonry: {},
            animationOptions: {
                duration: 750,
                easing: 'linear',
                queue: false,
            },
        });
    }
      // Masonry Portfolio
  if ($('.masonry-wrapper').length) {
  var $masonryContainer = $('.masonry-wrapper'),
      $itemsW = $('.work-item'),
      colW = $itemsW.outerWidth(true);


  $masonryContainer.isotope({
    resizable: false,
    masonry: {
      columnWidth: colW
    }
  }).isotope('reLayout');
  
  
  $(window).smartresize(function(){
    var colW = $itemsW.outerWidth(true);
    $masonryContainer.isotope({
      masonry: {
        columnWidth: colW
      }
    })
  });
  
  $('.filter a').click(function() {
        $('.filter a').removeClass('active');
        $(this).addClass('active');
        var selector = $(this).attr('data-filter');
        $masonryContainer.isotope({
            filter: selector
        });
        $masonryContainer.isotope('reLayout');
        return false;
    });
  } 
});