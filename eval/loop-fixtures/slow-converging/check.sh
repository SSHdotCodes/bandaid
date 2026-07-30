n=$(grep -c done src/stages.json 2>/dev/null || echo 0)
if [ "$n" -ge 4 ]; then exit 0; fi
echo "only $n of 4 stages done"
exit 1
