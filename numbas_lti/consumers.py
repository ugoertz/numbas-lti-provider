from django.http import HttpResponse
from channels.handler import AsgiHandler
from channels import Group
from channels.sessions import channel_session,enforce_ordering
from channels.auth import http_session_user, channel_session_user, channel_session_user_from_http
from channels.generic import BaseConsumer
import json

from django.contrib.auth.models import User

from .models import Attempt,ScormElement,Resource
from .report_outcome import report_outcome

@enforce_ordering(slight=True)
@channel_session_user_from_http
def scorm_connect(message,pk):
    print("CONNECT SCORM",message.user)
    print(message.content['path'])

@channel_session_user
def scorm_set_element(message,pk):
    print("SET",pk)
    data = json.loads(message.content['text'])
    print("{} things".format(len(data)))
    for element in data:
        if element['key']=='cmi.score.scaled':
            print('{}: {}'.format(element['key'],element['value'][:50]))
        attempt = Attempt.objects.get(pk=pk)
        ScormElement.objects.create(
            attempt = attempt,
            key = element['key'], 
            value = element['value']
        )
    print("DONE")

def report_scores(message,**kwargs):
    print("REPORT CONSUMER")
    resource = Resource.objects.get(pk=message['pk'])
    for user in User.objects.filter(attempts__resource=resource).distinct():
        report_outcome(resource,user)
