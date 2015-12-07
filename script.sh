#!/bin/bash
if (( $(ps -ef | grep http-server | wc -l) > 1 ))
then
echo "node is running!!!"
else
http-server . >> node.log 2>&1 &
fi