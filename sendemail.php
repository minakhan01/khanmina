<?php
# request sent using HTTP_X_REQUESTED_WITH
if( isset( $_SERVER['HTTP_X_REQUESTED_WITH'] ) AND ($_POST['url']=='')){                                  
	if (isset($_POST['name']) AND isset($_POST['email']) AND isset($_POST['message'])) {
		
    $to = 'saif.shajib@gmail.com';  // Change it by your email address
    $yourname ='Professional';
    $siteEmail = 'info@yoursite.com';
    
    $name = filter_var($_POST['name'], FILTER_SANITIZE_STRING);
		$email = filter_var($_POST['email'], FILTER_SANITIZE_EMAIL);
    $phone = $_POST['phone'];
    $subject = 'You\'ve been contacted by ' . $name . '.';
		$message = 'Additional Message are as follows:<br><br>'.filter_var($_POST['message'], FILTER_SANITIZE_STRING)."<br><br>"."You can contact $name via email, $email or via phone $phone";
    $sent = email($to, $siteEmail, $yourname, $subject, $message);
		if ($sent) {
			echo '<div class="content-message"><i class="fa fa-rocket"></i> Email Sent Successfully</div>';
		} else {
			echo "<div class='content-message'><i class='fa fa-times'></i> An error has occured. Please try later.</div>";
		}
	}
	else {
		echo 'All Fields are required';
	}
	return 'ERROR';
}

/**
 * email function
 *
 * @return bool | void
 **/
function email($to, $from_mail, $from_name, $subject, $message){
require 'PHPMailer/PHPMailerAutoload.php';

$mail = new PHPMailer;
$mail->From = $from_mail;
$mail->FromName = $from_name;
$mail->addAddress($to, $from_name);     // Add a recipient
$mail->addCC(''); //Optional ; Use for CC 
$mail->addBCC('');//Optional ; Use for BCC

$mail->WordWrap = 50;                                 // Set word wrap to 50 characters
$mail->isHTML(true);                                  // Set email format to HTML


//Remove below comment out code for SMTP stuff, otherwise don't touch this code. 
/*  
$mail->isSMTP();
$mail->Host = "mail.example.com";  //Set the hostname of the mail server
$mail->Port = 25;  //Set the SMTP port number - likely to be 25, 465 or 587
$mail->SMTPAuth = true;  //Whether to use SMTP authentication
$mail->Username = "yourname@example.com"; //Username to use for SMTP authentication
$mail->Password = "yourpassword"; //Password to use for SMTP authentication
*/
                    
$mail->Subject = $subject;
$mail->Body    = $message;
if($mail->send())return true; 

}
?>